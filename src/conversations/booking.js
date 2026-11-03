// 1. Импортируем наше подключение к базе данных better-sqlite3
const db = require('../config/database');

/**
 * Пошаговый сценарий записи на услугу
 */
async function bookingConversation(conversation, ctx) {
    try {
        // 2. Делаем запрос к вашей таблице services и достаем id, название и цену
        const services = db.prepare('SELECT id, name, price FROM services').all();

        // Если вдруг в базе нет услуг, вежливо сообщаем об этом
        if (services.length === 0) {
            await ctx.reply('К сожалению, список услуг сейчас пуст. Пожалуйста, обратитесь к администратору.');
            return; // Выходим из сценария
        }

        // 3. Подключаем InlineKeyboard из библиотеки grammy для создания кнопок под сообщением
        const { InlineKeyboard } = require('grammy');
        const keyboard = new InlineKeyboard();

        // 4. Перебираем все услуги из базы данных и для каждой создаем кнопку
        services.forEach((service) => {
            keyboard.text(`${service.name} (${service.price}₽)`, `service_${service.id}`).row();
        });

        // 5. Отправляем пользователю сообщение и прикрепляем наши динамические кнопки
        await ctx.reply('✨ Выберите желаемую услугу из списка:', { reply_markup: keyboard });

        // === ВОТ ЭТОГО ШАГА НЕ ХВАТАЛО ===
        // 6. Заставляем бота ОСТАНОВИТЬСЯ и ждать, пока пользователь нажмет на инлайн-кнопку
        const clickContext = await conversation.wait();

        // Проверяем, что пользователь нажал именно на инлайн-кнопку (callback_query)
        if (clickContext.callbackQuery) {
            const selectedServiceData = clickContext.callbackQuery.data; // Получим строку вида "service_1"
            
            // Отвечаем Telegram, что клик принят (чтобы кнопка перестала "мигать" часиками)
            await clickContext.answerCallbackQuery();
            
            // Временно выведем в чат то, что выбрал пользователь, чтобы проверить работу
            await clickContext.reply(`Отлично! Вы выбрали услугу с кодом: ${selectedServiceData}`);
        } else {
            // Если пользователь вместо клика по кнопке просто прислал текст или картинку
            await clickContext.reply('Пожалуйста, выберите услугу, нажав на одну из кнопок под сообщением.');
        }

    } catch (error) {
        console.error('Ошибка внутри сценария записи:', error);
        await ctx.reply('⚠️ Произошла ошибка. Пожалуйста, попробуйте позже.');
    }
}

// Экспортируем функцию, чтобы её можно было подключить в index.js
module.exports = { bookingConversation };
