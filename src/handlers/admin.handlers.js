const { InlineKeyboard } = require('grammy');
const db = require('../config/database');

function registerAdminHandlers(bot, helpers) {
    const adminId = String(process.env.ADMIN_TELEGRAM_ID);

    function isAdmin(ctx) {
        const userId = String(ctx.from?.id || '');
        if (!userId) return false;
        if (userId === adminId) return true;
        const user = db.prepare("SELECT role FROM users WHERE telegram_id = ?").get(userId);
        return user?.role === 'admin';
    }

    bot.hears('🗓 Расписание на сегодня', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply('⚠️ Доступ ограничен.');

        try {
            const currentMskTime = helpers.getTargetDateTimeString(3); 
            const currentDateStr = currentMskTime.split(' ')[0]; 
            const formattedToday = helpers.formatDate(currentMskTime); 

            const todaySchedule = db.prepare(`
                SELECT a.appointment_date AS appointmentDate, s.name AS serviceName, s.price, u.first_name AS firstName, u.username
                FROM appointments a
                JOIN services s ON a.service_id = s.id
                JOIN users u ON a.user_id = u.telegram_id
                WHERE a.appointment_date LIKE ? AND a.status = 'confirmed'
                ORDER BY a.appointment_date ASC
            `).all(`${currentDateStr}%`);

            if (todaySchedule.length === 0) {
                return await ctx.reply(`📅 <b>Расписание на сегодня (${formattedToday}):</b>\n\n📭 Записей пока нет.`, { parse_mode: 'HTML' });
            }

            let reportText = `📅 <b>Расписание визитов на сегодня (${formattedToday}):</b>\n\n`;
            let totalEarnings = 0;

            todaySchedule.forEach((app, index) => {
                const formattedTime = helpers.extractTime(app.appointmentDate);
                const usernameLabel = app.username ? `@${helpers.escapeHtml(app.username)}` : 'нет юзернейма';
                
                reportText += `${index + 1}. 🕒 <b>${formattedTime}</b> — <b>${helpers.escapeHtml(app.serviceName)}</b>\n`;
                reportText += `   👤 Клиент: ${helpers.escapeHtml(app.firstName)} (${usernameLabel})\n`;
                reportText += `   💰 Стоимость: ${app.price} ₽\n\n`;
                
                totalEarnings += app.price;
            });

            reportText += `📈 <b>Итого за сегодня:</b> ${totalEarnings} ₽`;
            await ctx.reply(reportText, { parse_mode: 'HTML' });

        } catch (error) {
            console.error('Ошибка расписания:', error);
            await ctx.reply('⚠️ Не удалось загрузить расписание.');
        }
    });

    bot.command('admin', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply('⚠️ Доступ ограничен.');

        try {
            const pendingAppointments = db.prepare(`
                SELECT a.id, a.appointment_date AS appointmentDate, s.name AS serviceName, s.price, u.first_name AS firstName, u.username
                FROM appointments a
                JOIN services s ON a.service_id = s.id
                JOIN users u ON a.user_id = u.telegram_id
                WHERE a.status = 'pending'
                ORDER BY a.appointment_date ASC
            `).all();

            if (pendingAppointments.length === 0) {
                return await ctx.reply('📭 Нет новых заявок на подтверждение.');
            }

            await ctx.reply(`🔔 <b>Найдено заявок: ${pendingAppointments.length}</b>`, { parse_mode: 'HTML' });

            for (const app of pendingAppointments) {
                const usernameLabel = app.username ? `@${helpers.escapeHtml(app.username)}` : 'нет юзернейма';
                const formattedDate = helpers.formatDate(app.appointmentDate);
                const formattedTime = helpers.extractTime(app.appointmentDate);

                const adminKeyboard = new InlineKeyboard()
                    .text('✅ Одобрить', `approve_app_${app.id}`)
                    .text('❌ Отклонить', `reject_app_${app.id}`);

                await ctx.reply(
                    `👤 <b>Клиент:</b> ${helpers.escapeHtml(app.firstName)} (${usernameLabel})\n` +
                    `💅 <b>Услуга:</b> ${helpers.escapeHtml(app.serviceName)} (${app.price} ₽)\n` +
                    `📅 <b>Дата:</b> ${formattedDate}\n` +
                    `⏰ <b>Время:</b> ${formattedTime}`,
                    { reply_markup: adminKeyboard, parse_mode: 'HTML' }
                );
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        } catch (error) {
            console.error('Ошибка в админ-панели:', error);
            await ctx.reply('⚠️ Ошибка загрузки админки.');
        }
    });

    bot.callbackQuery(/^approve_app_\d+$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery('Отказано в доступе');
        const appId = parseInt(ctx.callbackQuery.data.replace('approve_app_', ''), 10);

        try {
            const app = db.prepare('SELECT user_id AS userId, appointment_date AS appointmentDate, status FROM appointments WHERE id = ?').get(appId);
            if (!app) {
                return await ctx.answerCallbackQuery({ text: 'Запись не найдена.', show_alert: true });
            }

            if (app.status !== 'pending') {
                await ctx.editMessageText(
                    `${ctx.callbackQuery.message.text}\n\nℹ️ Статус записи уже был изменен (${app.status}).`,
                    { reply_markup: { inline_keyboard: [] } }
                ).catch(() => {});
                return await ctx.answerCallbackQuery('Заявка уже обработана');
            }

            db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ? AND status = 'pending'").run(appId);

            await ctx.answerCallbackQuery('Запись одобрена').catch(() => {});
            await ctx.editMessageText(
                `${ctx.callbackQuery.message.text}\n\n✅ Запись успешно подтверждена.`,
                { reply_markup: { inline_keyboard: [] } }
            ).catch(() => {});

            if (app.appointmentDate) {
                const formattedDate = helpers.formatDate(app.appointmentDate);
                const formattedTime = helpers.extractTime(app.appointmentDate);

                await bot.api.sendMessage(
                    String(app.userId),
                    `🎉 <b>Отличные новости!</b>\nВаша запись на <b>${formattedDate}</b> в <b>${formattedTime}</b> подтверждена! ✨`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }
        } catch (error) {
            console.error(error);
            await ctx.answerCallbackQuery('Ошибка БД');
        }
    });

    bot.callbackQuery(/^reject_app_\d+$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery('Отказано в доступе');
        const appId = parseInt(ctx.callbackQuery.data.replace('reject_app_', ''), 10);

        try {
            const app = db.prepare('SELECT user_id AS userId, status FROM appointments WHERE id = ?').get(appId);
            if (!app) {
                return await ctx.answerCallbackQuery({ text: 'Запись не найдена.', show_alert: true });
            }

            if (app.status !== 'pending') {
                await ctx.editMessageText(
                    `${ctx.callbackQuery.message.text}\n\nℹ️ Статус записи уже был изменен (${app.status}).`,
                    { reply_markup: { inline_keyboard: [] } }
                ).catch(() => {});
                return await ctx.answerCallbackQuery('Заявка уже обработана');
            }

            db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(appId);

            await ctx.answerCallbackQuery('Запись отклонена').catch(() => {});
            await ctx.editMessageText(
                `${ctx.callbackQuery.message.text}\n\n❌ Запись отклонена администратором.`,
                { reply_markup: { inline_keyboard: [] } }
            ).catch(() => {});

            await bot.api.sendMessage(
                String(app.userId),
                `⚠️ К сожалению, ваша заявка на запись была отклонена администратором.`
            ).catch(() => {});
        } catch (error) {
            console.error(error);
            await ctx.answerCallbackQuery('Ошибка БД');
        }
    });
}

module.exports = { registerAdminHandlers };
