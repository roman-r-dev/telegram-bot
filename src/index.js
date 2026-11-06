require('dotenv').config();
const { Bot, session, Keyboard, InlineKeyboard } = require('grammy'); 
const { conversations, createConversation } = require('@grammyjs/conversations');

// Импортируем подключение к базе данных
const db = require('./config/database');
const { initDatabase, UserModel } = require('./models/user.model');
const { bookingConversation } = require('./conversations/booking');

// Проверяем токен бота
if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("Ошибка: Токен бота не найден в файле .env!");
    process.exit(1);
}

// Извлекаем ID администратора из .env
const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);

// Запускаем инициализацию базы данных
initDatabase();

// Создаем экземпляр бота
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Подключаем базовые сессии (необходимы для работы плагина разговоров)
bot.use(session({
    initial: () => ({})
}));

// Подключаем плагин разговоров поверх сессий
bot.use(conversations());

// Регистрируем сценарий записи в боте
bot.use(createConversation(bookingConversation));

// Вспомогательная функция для проверки прав администратора
function isAdmin(ctx) {
    return ctx.from && ctx.from.id === adminId;
}

// --- ХЭНДЛЕР: Команда /start ---
bot.command('start', async (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || null;
    const firstName = ctx.from.first_name;

    try {
        // Добавлен await на случай, если метод работы с БД асинхронный
        await UserModel.upsertUser(telegramId, username, firstName);
        console.log(`[Bot] Пользователь ${firstName} (${telegramId}) успешно обработан в БД.`);
        
        const mainMenu = new Keyboard()
            .text('📅 Записаться на услугу')
            .text('🗂 Мои записи')
            .resized(); 

        await ctx.reply(
            `Привет, ${firstName}! Добро пожаловать в наш Салон Красоты. ✨\n\n` +
            `Вы можете записаться на процедуру или проверить свои текущие визиты с помощью кнопок ниже:`, 
            { reply_markup: mainMenu }
        );
    } catch (error) {
        console.error('Ошибка при сохранении пользователя в БД:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Пожалуйста, попробуйте позже.');
    }
});

// --- ХЭНДЛЕР: Запуск пошавого бронирования ---
bot.hears('📅 Записаться на услугу', async (ctx) => {
    await ctx.conversation.enter('bookingConversation');
});

// --- ХЭНДЛЕР: Просмотр записей клиентом ---
bot.hears('🗂 Мои записи', async (ctx) => {
    const telegramId = ctx.from.id;

    try {
        const appointments = db.prepare(`
            SELECT a.id, a.appointment_date, s.name AS service_name, s.price, a.status 
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            WHERE a.user_id = ? AND a.status != 'cancelled'
            ORDER BY a.appointment_date ASC
        `).all(telegramId);

        if (appointments.length === 0) {
            return await ctx.reply(
                'У вас пока нет активных записей. 🤷‍♂️\n\n' +
                'Нажмите на кнопку <b>📅 Записаться на услугу</b>, чтобы выбрать удобное время!',
                { parse_mode: 'HTML' }
            );
        }

        await ctx.reply('📋 <b>Ваши актуальные визиты в салон:</b>', { parse_mode: 'HTML' });

        for (const app of appointments) {
            const statusSmile = app.status === 'confirmed' ? '✅ Подтверждена' : '⏳ В ожидании одобрения';
            
            // Безопасное разделение даты на случай null/undefined в БД
            const dateStr = app.appointment_date || '';
            const [rawDate, rawTime] = dateStr.split(' ');
            const displayDate = rawDate ? rawDate.split('-').reverse().join('.') : 'Не указана';
            const displayTime = rawTime || 'Не указано';

            const cancelKeyboard = new InlineKeyboard()
                .text('❌ Отменить эту запись', `cancel_app_${app.id}`);

            await ctx.reply(
                `🔹 <b>Услуга:</b> ${app.service_name}\n` +
                `💰 <b>Стоимость:</b> ${app.price} ₽\n` +
                `📅 <b>Дата:</b> ${displayDate}\n` +
                `⏰ <b>Время:</b> ${displayTime}\n` + 
                `📌 <b>Статус:</b> ${statusSmile}`,
                { 
                    parse_mode: 'HTML', 
                    reply_markup: cancelKeyboard 
                }
            );
        }
    } catch (error) {
        console.error('Ошибка при получении записей пользователя:', error);
        await ctx.reply('⚠️ Не удалось загрузить ваши записи. Пожалуйста, попробуйте позже.');
    }
});

// --- ХЭНДЛЕР: Отмена записи клиентом ---
bot.callbackQuery(/^cancel_app_\d+$/, async (ctx) => {
    const appId = parseInt(ctx.callbackQuery.data.replace('cancel_app_', ''), 10);

    try {
        db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appId);
        await ctx.answerCallbackQuery('Запись успешно отменена!');
        
        // Убран parse_mode во избежание падения из-за отсутствия тегов в ctx.callbackQuery.message.text
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n🛑 Вы отменили этот визит.');
    } catch (error) {
        console.error('Ошибка при отмене записи в БД:', error);
        await ctx.answerCallbackQuery('Не удалось отменить запись.');
    }
});

// --- ХЭНДЛЕР: Панель администратора /admin ---
bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⚠️ Доступ ограничен. Вы не являетесь администратором.');

    try {
        const pendingApps = db.prepare(`
            SELECT a.id, a.appointment_date, s.name AS service_name, s.price, u.first_name, u.username
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            JOIN users u ON a.user_id = u.telegram_id
            WHERE a.status = 'pending'
            ORDER BY a.appointment_date ASC
        `).all();

        if (pendingApps.length === 0) {
            return await ctx.reply('📭 Нет новых заявок, ожидающих подтверждения.');
        }

        await ctx.reply(`🔔 <b>Найдено заявок на подтверждение: ${pendingApps.length}</b>`, { parse_mode: 'HTML' });

        for (const app of pendingApps) {
            const clientUser = app.username ? `@${app.username}` : 'нет юзернейма';
            
            // Безопасный split даты
            const dateStr = app.appointment_date || '';
            const [rawDate, rawTime] = dateStr.split(' ');
            const displayDate = rawDate ? rawDate.split('-').reverse().join('.') : 'Не указана';
            const displayTime = rawTime || 'Не указано';

            const adminKeyboard = new InlineKeyboard()
                .text('✅ Одобрить', `approve_app_${app.id}`)
                .text('❌ Отклонить', `reject_app_${app.id}`);

            await ctx.reply(
                `👤 <b>Клиент:</b> ${app.first_name} (${clientUser})\n` +
                `💅 <b>Услуга:</b> ${app.service_name} (${app.price} ₽)\n` +
                `📅 <b>Дата:</b> ${displayDate}\n` +
                `⏰ <b>Время:</b> ${displayTime}`,
                { reply_markup: adminKeyboard, parse_mode: 'HTML' }
            );
        }
    } catch (error) {
        console.error('Ошибка в админ-панели:', error);
        await ctx.reply('⚠️ Не удалось загрузить панель администратора.');
    }
});

// --- ХЭНДЛЕР: Одобрение записи администратором ---
bot.callbackQuery(/^approve_app_\d+$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery('Отказано в доступе');
    const appId = parseInt(ctx.callbackQuery.data.replace('approve_app_', ''), 10);

    try {
        const app = db.prepare('SELECT user_id, appointment_date FROM appointments WHERE id = ?').get(appId);
        db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?").run(appId);
        
        await ctx.answerCallbackQuery('Запись одобрена');
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Запись успешно подтверждена.');

        if (app && app.appointment_date) {
            const [rawDate, rawTime] = app.appointment_date.split(' ');
            const displayDate = rawDate ? rawDate.split('-').reverse().join('.') : 'Не указана';
            const displayTime = rawTime || 'Не указано';
            
            await ctx.api.sendMessage(
                app.user_id, 
                `🎉 <b>Отличные новости!</b>\nВаша запись на <b>${displayDate}</b> в <b>${displayTime}</b> успешно подтверждена администратором. Ждем вас! ✨`,
                { parse_mode: 'HTML' }
            ).catch(() => console.log('[Admin] Не удалось отправить уведомление пользователю'));
        }
    } catch (error) {
        console.error('Ошибка одобрения записи:', error);
        await ctx.answerCallbackQuery('Ошибка БД');
    }
});

// --- ХЭНДЛЕР: Отклонение записи администратором ---
bot.callbackQuery(/^reject_app_\d+$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery('Отказано в доступе');
    const appId = parseInt(ctx.callbackQuery.data.replace('reject_app_', ''), 10);

    try {
        const app = db.prepare('SELECT user_id FROM appointments WHERE id = ?').get(appId);
        db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appId);
        
        await ctx.answerCallbackQuery('Запись отклонена');
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ Запись отклонена администратором.');

        if (app) {
            await ctx.api.sendMessage(
                app.user_id, 
                `⚠️ К сожалению, ваша заявка на запись была отклонена администратором. Пожалуйста, выберите другое время для визита.`
            ).catch(() => console.log('[Admin] Не удалось отправить уведомление пользователю'));
        }
    } catch (error) {
        console.error('Ошибка отклонения записи:', error);
        await ctx.answerCallbackQuery('Ошибка БД');
    }
});

// --- ЗАПУСК БОТА ---
console.log('Бот успешно запускается в режиме разработки...');
bot.start();