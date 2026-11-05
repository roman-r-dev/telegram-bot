// 1. Импортируем наше подключение к базе данных better-sqlite3
const db = require('../config/database');

/**
 * Пошаговый сценарий записи на услугу
 */
async function bookingConversation(conversation, ctx) {
    try {
        // --- ШАГ 1: ВЫБОР УСЛУГИ ---
        const services = db.prepare('SELECT id, name, price FROM services').all();

        if (services.length === 0) {
            await ctx.reply('К сожалению, список услуг сейчас пуст.');
            return;
        }

        const { InlineKeyboard } = require('grammy');
        let keyboard = new InlineKeyboard();

        services.forEach((service) => {
            keyboard.text(`${service.name} (${service.price}₽)`, `service_${service.id}`).row();
        });

        await ctx.reply('✨ Выберите желаемую услугу из списка:', { reply_markup: keyboard });

        // Ждем клика по услуге
        let clickContext = await conversation.wait();

        // Если пользователь прислал текст вместо клика — просим нажать кнопку
        while (!clickContext.callbackQuery) {
            await clickContext.reply('Пожалуйста, выберите услугу, нажав на одну из кнопок выше.');
            clickContext = await conversation.wait();
        }

        // МГНОВЕННЫЙ ОТВЕТ ТЕЛЕГРАМУ (убирает тормоза и часики на кнопке!)
        await clickContext.answerCallbackQuery();

        // Достаем ID выбранной услуги
        const serviceData = clickContext.callbackQuery.data; // "service_1"
        const serviceId = serviceData.split('_')[1]; // Получим чистый ID, например "1"

        // Находим инфо об услуге в базе, чтобы красиво обращаться к пользователю
        const selectedService = services.find(s => s.id === parseInt(serviceId));


        // --- ШАГ 2: ВЫБОР ДАТЫ И ВРЕМЕНИ ---
        // Генерируем кнопки для 3 ближайших дней
        const dateKeyboard = new InlineKeyboard();
        
        // Массив названий дней недели для красоты
        const daysOfWeek = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        
        // Цикл для генерации Сегодня, Завтра, Послезавтра
        for (let i = 0; i < 3; i++) {
            const date = new Date();
            date.setDate(date.getDate() + i);
            
            const dayText = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${date.getDate()}.${date.getMonth() + 1}`;
            const dayName = daysOfWeek[date.getDay()];
            const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

            // Текст на кнопке: "Сегодня (Вв)", "Завтра (Ср)" или "05.11 (Чт)"
            dateKeyboard.text(`${dayText} (${dayName})`, `date_${formattedDate}`).row();
        }

        // Редактируем старое сообщение, чтобы интерфейс выглядел плавно
        await clickContext.editMessageText(
            `Вы выбрали: *${selectedService.name}*.\n\n📅 Теперь выберите удобный день для визита:`,
            { reply_markup: dateKeyboard, parse_mode: 'Markdown' }
        );

        // Ждем клика по дате
        clickContext = await conversation.wait();

        while (!clickContext.callbackQuery) {
            await clickContext.reply('Пожалуйста, выберите дату, нажав на кнопку.');
            clickContext = await conversation.wait();
        }

        // Снова мгновенно тушим «часики» загрузки
        await clickContext.answerCallbackQuery();

        const selectedDate = clickContext.callbackQuery.data.split('_')[1]; // Получим дату вида "2026-11-03"


        // --- ШАГ 3: ВВОД ВРЕМЕНИ ТЕКСТОМ ---
        await clickContext.editMessageText(
            `Отлично, дата выбрана! \n\n⏰ Напишите в ответном сообщении желаемое время визита (например, *14:30* или *18:00*):`,
            { parse_mode: 'Markdown' }
        );

        // Ждем, пока пользователь напишет время текстом
        const timeContext = await conversation.waitFor('message:text');
        const selectedTime = timeContext.msg.text;

        // Временный финал для проверки: выводим всё, что собрали
        await timeContext.reply(
            `🎉 *Проверка данных:*\n\n` +
            `Услуга ID: ${serviceId} (${selectedService.name})\n` +
            `Дата: ${selectedDate}\n` +
            `Время: ${selectedTime}\n\n` +
            `Все шаги работают! На следующем этапе мы запишем это в вашу базу данных.`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error('Ошибка внутри сценария записи:', error);
        await ctx.reply('⚠️ Произошла ошибка. Пожалуйста, попробуйте позже.');
    }
}

module.exports = { bookingConversation };
