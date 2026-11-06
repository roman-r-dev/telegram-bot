// 1. Все импорты строго на самом верху файла
const { InlineKeyboard } = require('grammy');
const db = require('../config/database');

/**
 * Вспомогательная функция для получения времени в нужном часовом поясе.
 * Гарантирует правильные даты и валидацию времени независимо от расположения сервера.
 * @param {number} offsetHours - Смещение часового пояса (например, 3 для МСК)
 */
function getTargetDate(offsetHours = 3) {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc + (3600000 * offsetHours));
}

/**
 * Пошаговый сценарий записи на услугу (Полная безопасная версия)
 */
async function bookingConversation(conversation, ctx) {
    try {
        const telegramId = ctx.from.id;

        // --- ШАГ 1: ВЫБОР УСЛУГИ ---
        // Безопасное чтение из SQLite без блокировки Event Loop
        const services = await conversation.external(() => {
            return db.prepare('SELECT id, name, price FROM services').all();
        });

        if (!services || services.length === 0) {
            await ctx.reply('К сожалению, список услуг сейчас пуст.');
            return;
        }

        const keyboard = new InlineKeyboard();
        services.forEach((service) => {
            keyboard.text(`${service.name} (${service.price}₽)`, `service_${service.id}`).row();
        });

        const initialMessage = await ctx.reply('✨ Выберите желаемую услугу из списка:', { reply_markup: keyboard });

        let clickContext = await conversation.wait();

        // Защита от текстового спама и левых кликов
        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('service_')) {
            await clickContext.reply('Пожалуйста, выберите услугу, нажав на одну из кнопок выше.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();

        const serviceData = clickContext.callbackQuery.data; 
        const serviceId = parseInt(serviceData.replace('service_', ''), 10); 

        const selectedService = services.find(s => s.id === serviceId);

        // Защита от удаления услуги из БД в процессе бронирования
        if (!selectedService) {
            await ctx.api.editMessageReplyMarkup(initialMessage.chat.id, initialMessage.message_id, { reply_markup: null });
            await clickContext.reply('⚠️ Данная услуга более недоступна. Пожалуйста, начните запись сначала с помощью команды /start.');
            return;
        }


        // --- ШАГ 2: ВЫБОР ДАТЫ ---
        const dateKeyboard = new InlineKeyboard();
        const daysOfWeek = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        
        for (let i = 0; i < 3; i++) {
            const date = getTargetDate(3);
            date.setDate(date.getDate() + i);
            
            const dayText = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
            const dayName = daysOfWeek[date.getDay()];
            const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

            dateKeyboard.text(`${dayText} (${dayName})`, `date_${formattedDate}`).row();
        }

        // При редактировании сообщения кнопки услуг Шага 1 автоматически исчезают
        await clickContext.editMessageText(
            `Вы выбрали: *${selectedService.name}*.\n\n📅 Теперь выберите удобный день для визита:`,
            { reply_markup: dateKeyboard, parse_mode: 'Markdown' }
        );

        clickContext = await conversation.wait();

        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('date_')) {
            await clickContext.reply('Пожалуйста, выберите дату, нажав на одну из кнопок под сообщением.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();
        
        // ЧИСТАЯ СТРОКА: Никаких промежуточных массивов .split('_'). Строго строка YYYY-MM-DD.
        const selectedDate = clickContext.callbackQuery.data.replace('date_', ''); 
        const displayDate = selectedDate.split('-').reverse().join('.');


        // --- ШАГ 3: ВВОД ВРЕМЕНИ ТЕКСТОМ С ЖЕСТКОЙ ВАЛИДАЦИЕЙ ---
        // reply_markup: null полностью стирает кнопки дат, предотвращая баги кликов по истории
        await clickContext.editMessageText(
            `Отлично, дата выбрана: *${displayDate}* \n\n⏰ Напишите в ответном сообщении желаемое время визита (например, *14:30* или *18:00*):`,
            { parse_mode: 'Markdown', reply_markup: null }
        );

        let selectedTime;
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

        while (true) {
            let timeContext = await conversation.waitFor('message:text');
            const inputTime = timeContext.msg.text.trim();

            // 1. Проверяем корректность самого формата ЧЧ:ММ
            if (!timeRegex.test(inputTime)) {
                await timeContext.reply('⚠️ Некорректный формат времени.\nПожалуйста, введите время в формате *ЧЧ:ММ* (например, *15:00*):', { parse_mode: 'Markdown' });
                continue;
            }

            // 2. Защита от записи в прошлое время (актуально, если выбран день "Сегодня")
            const todayStr = getTargetDate(3).toISOString().split('T')[0];
            if (selectedDate === todayStr) {
                const [inputHours, inputMinutes] = inputTime.split(':').map(Number);
                const nowTarget = getTargetDate(3);
                const currentHours = nowTarget.getHours();
                const currentMinutes = nowTarget.getMinutes();

                // Если введенное время уже прошло
                if (inputHours < currentHours || (inputHours === currentHours && inputMinutes <= currentMinutes)) {
                    await timeContext.reply(`⚠️ Нельзя записаться на прошедшее время. Сейчас уже *${String(currentHours).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}*.\nУкажите другое время:`, { parse_mode: 'Markdown' });
                    continue;
                }
            }

            selectedTime = inputTime;
            break;
        }


        // --- ШАГ 4: СОХРАНЕНИЕ В БАЗУ ДАННЫХ ---
        await conversation.external(() => {
            const stmt = db.prepare(`
                INSERT INTO appointments (user_id, service_id, appointment_date, status)
                VALUES (?, ?, ?, 'pending')
            `);
            const fullDateTime = `${selectedDate} ${selectedTime}`;
            return stmt.run(telegramId, serviceId, fullDateTime);
        });

        // Финальный красивый ответ клиенту
        await ctx.reply(
            `🎉 *Вы успешно записаны!* \n\n` +
            `💅 *Услуга:* ${selectedService.name}\n` +
            `📅 *Дата и время:* ${displayDate} в ${selectedTime}\n\n` +
            `Администратор свяжется с вами для подтверждения. Спасибо!`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error('Ошибка внутри сценария записи:', error);
        await ctx.reply('⚠️ Произошла непредвиденная ошибка при бронировании. Пожалуйста, попробуйте запустить сценарий позже.');
    }
}

module.exports = { bookingConversation };