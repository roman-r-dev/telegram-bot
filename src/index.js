require('dotenv').config();
const { Bot, session, Keyboard, InlineKeyboard } = require('grammy'); 
const { conversations, createConversation } = require('@grammyjs/conversations');
const cron = require('node-cron');

const db = require('./config/database');
const { initDatabase, UserModel } = require('./models/user.model');
const { bookingConversation } = require('./conversations/booking');

if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("Ошибка: Токен бота не найден в файле .env!");
    process.exit(1);
}

const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);

initDatabase();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session({
    initial: () => ({})
}));

bot.use(conversations());
bot.use(createConversation(bookingConversation));

function isAdmin(ctx) {
    return ctx.from && ctx.from.id === adminId;
}

function getTargetDateTimeString(offsetHours = 3) {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const targetDate = new Date(utc + (3600000 * offsetHours));
    
    const YYYY = targetDate.getFullYear();
    const MM = String(targetDate.getMonth() + 1).padStart(2, '0');
    const DD = String(targetDate.getDate()).padStart(2, '0');
    const HH = String(targetDate.getHours()).padStart(2, '0');
    const mm = String(targetDate.getMinutes()).padStart(2, '0');
    
    return `${YYYY}-${MM}-${DD} ${HH}:${mm}`;
}

// --- ХЭНДЛЕРЫ КЛИЕНТА ---

bot.command('start', async (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || null;
    const firstName = ctx.from.first_name;

    try {
        await UserModel.upsertUser(telegramId, username, firstName);
        console.log(`[Bot] Пользователь ${firstName} (${telegramId}) успешно обработан в БД.`);
        
        const mainMenu = new Keyboard()
            .text('📅 Записаться на услугу')
            .text('🗂 Мои записи');
            
        if (isAdmin(ctx)) {
            mainMenu.row().text('🗓 Расписание на сегодня');
        }

        mainMenu.resized();

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

bot.hears('📅 Записаться на услугу', async (ctx) => {
    await ctx.conversation.enter('bookingConversation');
});

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

bot.callbackQuery(/^cancel_app_\d+$/, async (ctx) => {
    const appId = parseInt(ctx.callbackQuery.data.replace('cancel_app_', ''), 10);

    try {
        db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appId);
        await ctx.answerCallbackQuery('Запись успешно отменена!');
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n🛑 Вы отменили этот визит.');
    } catch (error) {
        console.error('Ошибка при отмене записи в БД:', error);
        await ctx.answerCallbackQuery('Не удалось отменить запись.');
    }
});
// --- ХЭНДЛЕРЫ АДМИНИСТРАТОРА ---

// Просмотр актуального расписания салона на сегодня
bot.hears('🗓 Расписание на сегодня', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⚠️ Доступ ограничен. Вы не являетесь администратором.');

    try {
        // 1. Получаем текущую дату сервера в формате YYYY-MM-DD (с учетом МСК)
        const nowMsk = getTargetDateTimeString(3);
        
        // ИСПРАВЛЕНО: Корректно извлекаем чистую строку даты из сплита по пробелу
        const todayDate = nowMsk.split(' ')[0]; 
        const displayToday = todayDate.split('-').reverse().join('.');

        // 2. Делаем SQL-запрос ко всем подтвержденным записям на сегодня
        const todaySchedule = db.prepare(`
            SELECT a.appointment_date, s.name AS service_name, s.price, u.first_name, u.username
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            JOIN users u ON a.user_id = u.telegram_id
            WHERE a.appointment_date LIKE ? AND a.status = 'confirmed'
            ORDER BY a.appointment_date ASC
        `).all(`${todayDate}%`);

        if (todaySchedule.length === 0) {
            return await ctx.reply(`📅 <b>Расписание на сегодня (${displayToday}):</b>\n\n📭 Подтвержденных записей на сегодня пока нет. Все новые заявки можно проверить через команду /admin.`, { parse_mode: 'HTML' });
        }

        // 3. Формируем красивый структурированный отчет для админа
        let reportText = `📅 <b>Расписание визитов на сегодня (${displayToday}):</b>\n\n`;
        let totalEarnings = 0;

        todaySchedule.forEach((app, index) => {
            const dateTime = app.appointment_date || '';
            const rawTime = dateTime.split(' ')[1] || '00:00';
            const clientUser = app.username ? `@${app.username}` : 'нет юзернейма';
            
            reportText += `${index + 1}. 🕒 <b>${rawTime}</b> — <b>${app.service_name}</b>\n`;
            reportText += `   👤 Клиент: ${app.first_name} (${clientUser})\n`;
            reportText += `   💰 Стоимость: ${app.price} ₽\n\n`;
            
            totalEarnings += app.price;
        });

        reportText += `📈 <b>Итого за сегодня:</b> ${totalEarnings} ₽`;

        await ctx.reply(reportText, { parse_mode: 'HTML' });

    } catch (error) {
        console.error('Ошибка при формировании расписания для админа:', error);
        await ctx.reply('⚠️ Не удалось загрузить расписание. Пожалуйста, проверьте консоль.');
    }
});

// Просмотр новых заявок, ожидающих модерации (статус 'pending')
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
        await ctx.reply('⚠️ Не удалось загрузить панели администратора.');
    }
});

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

// --- СИСТЕМА НАПОМИНАНИЙ (CRON) ---

cron.schedule('* * * * *', async () => {
    try {
        const nowMsk = getTargetDateTimeString(3);
        const targetTime = new Date(nowMsk.replace(' ', 'T'));
        targetTime.setHours(targetTime.getHours() + 2);

        const YYYY = targetTime.getFullYear();
        const MM = String(targetTime.getMonth() + 1).padStart(2, '0');
        const DD = String(targetTime.getDate()).padStart(2, '0');
        const HH = String(targetTime.getHours()).padStart(2, '0');
        const mm = String(targetTime.getMinutes()).padStart(2, '0');
        
        const timeToSearch = `${YYYY}-${MM}-${DD} ${HH}:${mm}`;

        const reminders = db.prepare(`
            SELECT a.id, a.user_id, a.appointment_date, s.name AS service_name
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            WHERE a.appointment_date = ? AND a.status = 'confirmed'
        `).all(timeToSearch);

        for (const app of reminders) {
            const [, rawTime] = app.appointment_date.split(' ');

            await bot.api.sendMessage(
                app.user_id,
                `⏰ <b>Напоминание о визите!</b>\n\n` +
                `Ждем вас сегодня через 2 часа в <b>${rawTime}</b> на услугу <b>${app.service_name}</b>. ✨\n\n` +
                `Если ваши планы изменились, вы можете отменить запись в разделе «🗂 Мои записи».`,
                { parse_mode: 'HTML' }
            ).catch((err) => {
                console.error(`[Cron] Не удалось отправить сообщение ${app.user_id}:`, err.message);
            });
            
            console.log(`[Cron] Напоминание для записи ID ${app.id} успешно отправлено.`);
        }
    } catch (error) {
        console.error('Ошибка фоновой задачи напоминаний:', error);
    }
});

console.log('[Cron] Планировщик напоминаний запущен.');
console.log('Бот успешно запускается в режиме разработки...');
bot.start();
