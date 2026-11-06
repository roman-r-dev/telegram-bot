// ====================================================================
// 1. ИМПОРТЫ И НАСТРОЙКА ОКРУЖЕНИЯ
// ====================================================================
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

// ====================================================================
// 2. ОСНОВНОЙ СЦЕНАРИЙ ПОШАГОВОГО БРОНИРОВАНИЯ
// ====================================================================
async function bookingConversation(conversation, ctx) {
    try {
        const telegramId = ctx.from.id;

        // --- ШАГ 1: ВЫБОР УСЛУГИ ---
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

        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('service_')) {
            await clickContext.reply('Пожалуйста, выберите услугу, нажав на одну из кнопок выше.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();

        const serviceData = clickContext.callbackQuery.data; 
        const serviceId = parseInt(serviceData.replace('service_', ''), 10); 
        const selectedService = services.find(s => s.id === serviceId);

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
        
        const selectedDate = clickContext.callbackQuery.data.replace('date_', ''); 
        const displayDate = selectedDate.split('-').reverse().join('.');


        // --- ШАГ 3: ДИНАМИЧЕСКИЙ ВЫБОР ВРЕМЕНИ (СЛОТЫ ВМЕСТО ТЕКСТА) ---
        const bookedAppointments = await conversation.external(() => {
            return db.prepare(`
                SELECT appointment_date 
                FROM appointments 
                WHERE appointment_date LIKE ? AND status != 'cancelled'
            `).all(`${selectedDate}%`);
        });

        const busySlots = bookedAppointments.map(app => {
            const dateTime = app.appointment_date || '';
            const splitData = dateTime.split(' ');
            return splitData[1] || ''; // Забираем чистую строку времени "HH:MM"
        });

        const allSalonSlots = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30', '19:00'];
        
        const timeKeyboard = new InlineKeyboard();
        let availableSlotsCount = 0;

        const nowTarget = getTargetDate(3);
        const todayStr = nowTarget.toISOString().split('T')[0];
        const isToday = selectedDate === todayStr;

        allSalonSlots.forEach((slotTime) => {
            if (busySlots.includes(slotTime)) return;

            if (isToday) {
                const [slotHours, slotMinutes] = slotTime.split(':').map(Number);
                const currentHours = nowTarget.getHours();
                const currentMinutes = nowTarget.getMinutes();

                if (slotHours < currentHours || (slotHours === currentHours && slotMinutes <= currentMinutes)) {
                    return; 
                }
            }

            timeKeyboard.text(slotTime, `time_${slotTime}`);
            availableSlotsCount++;
            if (availableSlotsCount % 3 === 0) timeKeyboard.row();
        });

        if (availableSlotsCount === 0) {
            await clickContext.editMessageText(
                `😔 К сожалению, на выбранную дату (<b>${displayDate}</b>) свободные места закончились или рабочее время салона вышло.\n\n` +
                `Пожалуйста, начните сначала и выберите другой день.`, 
                { parse_mode: 'HTML', reply_markup: null }
            );
            return;
        }

        await clickContext.editMessageText(
            `Отлично, дата выбрана: *${displayDate}* \n\n⏰ Выберите свободное время для визита:`,
            { reply_markup: timeKeyboard, parse_mode: 'Markdown' }
        );

        clickContext = await conversation.wait();

        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('time_')) {
            await clickContext.reply('Пожалуйста, выберите время, нажав на одну из кнопок ниже.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();
        const selectedTime = clickContext.callbackQuery.data.replace('time_', '');


        // --- ШАГ 4: СОХРАНЕНИЕ В БАЗУ ДАННЫХ И УВЕДОМЛЕНИЕ АДМИНА ---
        const insertResult = await conversation.external(() => {
            const stmt = db.prepare(`
                INSERT INTO appointments (user_id, service_id, appointment_date, status)
                VALUES (?, ?, ?, 'pending')
            `);
            const fullDateTime = `${selectedDate} ${selectedTime}`;
            return stmt.run(telegramId, serviceId, fullDateTime);
        });

        await clickContext.editMessageText(`Вы выбрали время: *${selectedTime}*. Оформляю запись... ⏳`, { parse_mode: 'Markdown', reply_markup: null });

        const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
        if (adminId && !isNaN(adminId)) {
            const clientName = ctx.from.first_name;
            const clientUser = ctx.from.username ? `@${ctx.from.username}` : 'нет юзернейма';
            
            const quickAdminKeyboard = new InlineKeyboard()
                .text('✅ Одобрить', `approve_app_${insertResult.lastInsertRowid}`)
                .text('❌ Отклонить', `reject_app_${insertResult.lastInsertRowid}`);

            await ctx.api.sendMessage(
                adminId,
                `🔔 <b>Новая заявка на запись!</b>\n\n` +
                `👤 <b>Клиент:</b> ${clientName} (${clientUser})\n` +
                `💅 <b>Услуга:</b> ${selectedService.name} (${selectedService.price} ₽)\n` +
                `📅 <b>Дата:</b> ${displayDate}\n` +
                `⏰ <b>Время:</b> ${selectedTime}\n\n` +
                `📥 Вы можете подтвердить или отклонить заявку кнопками ниже:`,
                { parse_mode: 'HTML', reply_markup: quickAdminKeyboard }
            ).catch((err) => console.error('[Notification Error] Не удалось отправить сообщение админу:', err));
        }

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

// ====================================================================
// 3. ЭКСПОРТ МОДУЛЯ ДЛЯ ИНТЕГРАЦИИ В INDEX.JS
// ====================================================================
module.exports = { bookingConversation };
