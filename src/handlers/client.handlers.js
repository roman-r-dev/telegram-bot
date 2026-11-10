const { Keyboard, InlineKeyboard, ReplyKeyboardRemove } = require('grammy');
const db = require('../config/database');
const { UserModel } = require('../models/user.model');

function registerClientHandlers(bot, helpers) {
    bot.command('start', async (ctx) => {
        await ctx.conversation.exit();
        
        const telegramId = String(ctx.from.id);
        const username = ctx.from.username || null;
        const firstName = ctx.from.first_name;

        try {
            await UserModel.upsertUser(telegramId, username, firstName);
            console.log(`[Bot] Пользователь ${firstName} (${telegramId}) обработан.`);
            
            const mainMenu = new Keyboard()
                .text('📅 Записаться на услугу')
                .text('🗂 Мои записи');
                
            const adminId = String(process.env.ADMIN_TELEGRAM_ID);
            if (String(ctx.from?.id) === adminId) {
                mainMenu.row().text('🗓 Расписание на сегодня');
            }

            mainMenu.resized();

            await ctx.reply(
                `Привет, ${helpers.escapeHtml(firstName)}! Добро пожаловать в наш Салон Красоты. ✨\n\n` +
                `Вы можете записаться на процедуру или проверить свои визиты кнопками ниже:`, 
                { reply_markup: mainMenu }
            );
        } catch (error) {
            console.error('Ошибка при сохранении пользователя в БД:', error);
            await ctx.reply('Произошла ошибка при запуске бота. Пожалуйста, попробуйте позже.');
        }
    });

    bot.hears('📅 Записаться на услугу', async (ctx) => {
        await ctx.reply('Переходим к оформлению записи...', { reply_markup: {remove_keyboard: true}});
        await ctx.conversation.enter('bookingConversation');
    });

    bot.hears('🗂 Мои записи', async (ctx) => {
        const telegramId = String(ctx.from.id);

        try {
            const appointments = db.prepare(`
                SELECT a.id, a.appointment_date AS appointmentDate, s.name AS serviceName, s.price, a.status 
                FROM appointments a
                JOIN services s ON a.service_id = s.id
                WHERE CAST(a.user_id AS TEXT) = ? AND a.status != 'cancelled'
                ORDER BY a.appointment_date ASC
            `).all(telegramId);

            if (appointments.length === 0) {
                return await ctx.reply(
                    'У вас пока нет активных записей. 🤷‍♂️\n\n' +
                    'Нажмите на кнопку <b>📅 Записаться на услугу</b>!',
                    { parse_mode: 'HTML' }
                );
            }

            await ctx.reply('📋 <b>Ваши актуальные визиты в салон:</b>', { parse_mode: 'HTML' });

            for (const app of appointments) {
                const statusLabel = app.status === 'confirmed' ? '✅ Подтверждена' : '⏳ В ожидании одобрения';
                
                const formattedDate = helpers.formatDate(app.appointmentDate);
                const formattedTime = helpers.extractTime(app.appointmentDate);

                const cancelKeyboard = new InlineKeyboard()
                    .text('❌ Отменить эту запись', `cancel_app_${app.id}`);

                await ctx.reply(
                    `🔹 <b>Услуга:</b> ${helpers.escapeHtml(app.serviceName)}\n` +
                    `💰 <b>Стоимость:</b> ${app.price} ₽\n` +
                    `📅 <b>Дата:</b> ${formattedDate}\n` +
                    `⏰ <b>Время:</b> ${formattedTime}\n` + 
                    `📌 <b>Статус:</b> ${statusLabel}`,
                    { 
                        parse_mode: 'HTML', 
                        reply_markup: cancelKeyboard 
                    }
                );
            }
        } catch (error) {
            console.error('Ошибка при получении записей пользователя:', error);
            await ctx.reply('⚠️ Не удалось загрузить ваши записи.');
        }
    });

    bot.callbackQuery(/^cancel_app_\d+$/, async (ctx) => {
        const appId = parseInt(ctx.callbackQuery.data.replace('cancel_app_', ''), 10);
        const userId = String(ctx.from.id);

        try {
            const result = db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND CAST(user_id AS TEXT) = ?").run(appId, userId);
            
            if (result.changes === 0) {
                return await ctx.answerCallbackQuery('Запись не найдена или у вас нет прав на отмену.').catch(() => {});
            }

            await ctx.answerCallbackQuery('Запись успешно отменена!').catch(() => {});
            await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n🛑 Вы отменили этот визит.').catch(() => {});
        } catch (error) {
            console.error('Ошибка при отмене записи в БД:', error);
            await ctx.answerCallbackQuery('Не удалось отменить запись.').catch(() => {});
        }
    });
}

module.exports = { registerClientHandlers };
