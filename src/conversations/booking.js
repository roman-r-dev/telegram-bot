const { InlineKeyboard, Keyboard } = require('grammy');
const db = require('../config/database');

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getTargetDateFromTimestamp(timestampMs, offsetHours = 3) {
    const now = new Date(timestampMs);
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc + (3600000 * offsetHours));
}

async function removeButtons(ctx, message) {
    if (message) {
        await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, { reply_markup: null }).catch(() => {});
    }
}

async function buildMainMenu(conversation, userId) {
    const mainMenu = new Keyboard().text('📅 Записаться на услугу').text('🗂 Мои записи');
    const currentUserId = String(userId ?? '');

    const userRecord = await conversation.external(() => {
        return db.prepare('SELECT role FROM users WHERE telegram_id = ?').get(currentUserId);
    });

    if (userRecord?.role === 'admin' || currentUserId === String(process.env.ADMIN_TELEGRAM_ID)) {
        mainMenu.row().text('🗓 Расписание на сегодня');
    }

    return mainMenu.resized();
}

function isInterruptCommand(ctx) {
    const text = ctx.message?.text || '';
    return text === '/start' || text === '🗂 Мои записи' || text === '🗓 Расписание на сегодня';
}

async function bookingConversation(conversation, ctx) {
    try {
        const telegramId = ctx.from.id;

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

        let currentMessage = await ctx.reply('✨ Выберите желаемую услугу из списка:', { reply_markup: keyboard });
        let clickContext = await conversation.wait();

        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('service_')) {
            if (isInterruptCommand(clickContext)) {
                await removeButtons(ctx, currentMessage);
                const mainMenu = await buildMainMenu(conversation, telegramId);
                await clickContext.reply('Оформление записи прервано. Вы вернулись в меню:', { reply_markup: mainMenu });
                return;
            }
            await clickContext.reply('Пожалуйста, выберите услугу, нажав на одну из кнопок выше.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();
        await removeButtons(ctx, currentMessage);

        const serviceData = clickContext.callbackQuery.data;
        const serviceId = parseInt(serviceData.replace('service_', ''), 10);
        const selectedService = services.find(s => s.id === serviceId);

        if (!selectedService) {
            await clickContext.reply('⚠️ Данная услуга более недоступна. Пожалуйста, начните запись сначала с помощью команды /start.');
            return;
        }

        const safeServiceName = escapeHtml(selectedService.name);

        const existingApp = await conversation.external(() => {
            return db.prepare(`
                SELECT id, appointment_date FROM appointments 
                WHERE user_id = ? AND service_id = ? AND status IN ('pending', 'confirmed')
                LIMIT 1
            `).get(telegramId, serviceId);
        });

        let isRescheduling = false;
        let appointmentIdToUpdate = null;

        if (existingApp) {
            appointmentIdToUpdate = existingApp.id;

            const [oldRawDate = '', oldRawTime = ''] = (existingApp.appointment_date || '').split(' ');
            const oldDisplayDate = oldRawDate ? oldRawDate.split('-').reverse().join('.') : 'не указана';
            const oldDisplayTime = oldRawTime ? oldRawTime.slice(0, 5) : '';

            const rescheduleKeyboard = new InlineKeyboard()
                .text('🔄 Да, перенести визит', 'action_reschedule').row()
                .text('❌ Нет, оставить как есть', 'action_cancel_flow');

            currentMessage = await clickContext.reply(
                `🗓 <b>У вас уже есть активная запись на услугу "${safeServiceName}":</b>\n` +
                `📅 Дата: <b>${escapeHtml(oldDisplayDate)}</b> в <b>${escapeHtml(oldDisplayTime)}</b>.\n\n` +
                `Желаете перенести этот визит на другое время? Новому бронированию будет присвоен статус "В ожидании".`,
                { reply_markup: rescheduleKeyboard, parse_mode: 'HTML' }
            );

            let actionContext = await conversation.wait();
            while (!actionContext.callbackQuery || !['action_reschedule', 'action_cancel_flow'].includes(actionContext.callbackQuery.data)) {
                if (isInterruptCommand(actionContext)) {
                    await removeButtons(ctx, currentMessage);
                    const mainMenu = await buildMainMenu(conversation, telegramId);
                    await actionContext.reply('Перенос записи прерван. Вы вернулись в меню:', { reply_markup: mainMenu });
                    return;
                }
                await actionContext.reply('Пожалуйста, выберите один из вариантов ниже.');
                actionContext = await conversation.wait();
            }

            await actionContext.answerCallbackQuery();
            await removeButtons(ctx, currentMessage);

            if (actionContext.callbackQuery.data === 'action_cancel_flow') {
                const mainMenu = await buildMainMenu(conversation, telegramId);
                await actionContext.reply('👍 Отлично, ваша текущая запись остается в силе. Ждем вас в салоне!', { reply_markup: mainMenu });
                return;
            }

            isRescheduling = true;
            clickContext = actionContext;
        }

        const dateKeyboard = new InlineKeyboard();
        const daysOfWeek = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        const step2Timestamp = await conversation.now();
        const allowedDates = new Set();

        for (let i = 0; i < 3; i++) {
            const date = getTargetDateFromTimestamp(step2Timestamp, 3);
            date.setDate(date.getDate() + i);

            const dayText = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
            const dayName = daysOfWeek[date.getDay()];
            const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

            allowedDates.add(formattedDate);
            dateKeyboard.text(`${dayText} (${dayName})`, `date_${formattedDate}`).row();
        }

        const step2Text = `Вы выбрали: <b>${safeServiceName}</b>.\n\n📅 Теперь выберите удобный день для визита:`;
        currentMessage = await clickContext.reply(step2Text, { reply_markup: dateKeyboard, parse_mode: 'HTML' });

        clickContext = await conversation.wait();

        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('date_')) {
            if (isInterruptCommand(clickContext)) {
                await removeButtons(ctx, currentMessage);
                const mainMenu = await buildMainMenu(conversation, telegramId);
                await clickContext.reply('Оформление записи прервано. Вы вернулись в меню:', { reply_markup: mainMenu });
                return;
            }
            await clickContext.reply('Пожалуйста, выберите дату, нажав на одну из кнопок под сообщением.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();
        await removeButtons(ctx, currentMessage);

        const selectedDate = clickContext.callbackQuery.data.replace('date_', '');
        if (!allowedDates.has(selectedDate)) {
            const mainMenu = await buildMainMenu(conversation, telegramId);
            await clickContext.reply('⚠️ Выбрана недоступная дата. Пожалуйста, начните запись заново.', { reply_markup: mainMenu });
            return;
        }
        const displayDate = selectedDate.split('-').reverse().join('.');
        const bookedAppointments = await conversation.external(() => {
            return db.prepare(`
                SELECT appointment_date 
                FROM appointments 
                WHERE appointment_date LIKE ? AND status != 'cancelled'
            `).all(`${selectedDate}%`);
        });

        const busySlots = new Set(bookedAppointments.map(app => {
            const dateTime = app.appointment_date || '';
            const splitData = dateTime.split(' ');
            return (splitData[1] || '').slice(0, 5);
        }));

        const allSalonSlots = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30', '19:00'];
        const timeKeyboard = new InlineKeyboard();
        let availableSlotsCount = 0;

        const step3Timestamp = await conversation.now();
        const nowTarget = getTargetDateFromTimestamp(step3Timestamp, 3);
        const todayStr = `${nowTarget.getFullYear()}-${String(nowTarget.getMonth() + 1).padStart(2, '0')}-${String(nowTarget.getDate()).padStart(2, '0')}`;
        const isToday = selectedDate === todayStr;

        const currentHours = nowTarget.getHours();
        const currentMinutes = nowTarget.getMinutes();

        for (const slotTime of allSalonSlots) {
            if (busySlots.has(slotTime)) continue;

            if (isToday) {
                const [slotHours, slotMinutes] = slotTime.split(':').map(Number);
                if (slotHours < currentHours || (slotHours === currentHours && slotMinutes <= currentMinutes)) {
                    continue;
                }
            }

            timeKeyboard.text(slotTime, `time_${slotTime}`);
            availableSlotsCount++;
            if (availableSlotsCount % 3 === 0) timeKeyboard.row();
        }

        if (availableSlotsCount === 0) {
            const mainMenu = await buildMainMenu(conversation, telegramId);
            await clickContext.reply(
                `😔 К сожалению, на выбранную дату (<b>${escapeHtml(displayDate)}</b>) свободные места закончились или рабочее время салона вышло.\n\n` +
                `Пожалуйста, начните сначала и выберите другой день.`,
                { parse_mode: 'HTML', reply_markup: mainMenu }
            );
            return;
        }

        currentMessage = await clickContext.reply(
            `Отлично, дата выбрана: <b>${escapeHtml(displayDate)}</b>\n\n⏰ Выберите удобное время для визита:`,
            { reply_markup: timeKeyboard, parse_mode: 'HTML' }
        );

        clickContext = await conversation.wait();

        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('time_')) {
            if (isInterruptCommand(clickContext)) {
                await removeButtons(ctx, currentMessage);
                const mainMenu = await buildMainMenu(conversation, telegramId);
                await clickContext.reply('Оформление записи прервано. Вы вернулись в меню:', { reply_markup: mainMenu });
                return;
            }
            await clickContext.reply('Пожалуйста, выберите время, нажав на одну из кнопок ниже.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();
        await removeButtons(ctx, currentMessage);

        const selectedTime = clickContext.callbackQuery.data.replace('time_', '');
        if (!allSalonSlots.includes(selectedTime)) {
            const mainMenu = await buildMainMenu(conversation, telegramId);
            await clickContext.reply('⚠️ Выбрано недопустимое время. Пожалуйста, начните запись заново.', { reply_markup: mainMenu });
            return;
        }

        const fullDateTime = `${selectedDate} ${selectedTime}:00`;

        const bookingResult = await conversation.external(() => {
            const saveBooking = db.transaction(() => {
                const conflict = db.prepare(`
                    SELECT id FROM appointments 
                    WHERE appointment_date = ? AND status != 'cancelled' AND id != ?
                    LIMIT 1
                `).get(fullDateTime, appointmentIdToUpdate ?? -1);

                if (conflict) {
                    return { error: 'conflict', rowId: null };
                }

                if (isRescheduling) {
                    const updated = db.prepare(`
                        UPDATE appointments 
                        SET appointment_date = ?, status = 'pending', reminder_sent = 0 
                        WHERE id = ? AND user_id = ? AND status IN ('pending', 'confirmed')
                    `).run(fullDateTime, appointmentIdToUpdate, telegramId);

                    if (updated.changes === 0) {
                        return { error: 'not_found', rowId: null };
                    }
                    return { error: null, rowId: appointmentIdToUpdate };
                } else {
                    const result = db.prepare(`
                        INSERT INTO appointments (user_id, service_id, appointment_date, status, reminder_sent)
                        VALUES (?, ?, ?, 'pending', 0)
                    `).run(telegramId, serviceId, fullDateTime);
                    return { error: null, rowId: Number(result.lastInsertRowid) };
                }
            });

            return saveBooking();
        });

        if (bookingResult.error === 'conflict') {
            const mainMenu = await buildMainMenu(conversation, telegramId);
            await clickContext.reply(
                '⚠️ К сожалению, выбранное время только что занял другой клиент. Пожалуйста, выберите другое время или дату.',
                { reply_markup: mainMenu }
            );
            return;
        }

        if (bookingResult.error === 'not_found') {
            const mainMenu = await buildMainMenu(conversation, telegramId);
            await clickContext.reply(
                '⚠️ Исходная запись уже была отменена или удалена. Пожалуйста, оформите новую запись.',
                { reply_markup: mainMenu }
            );
            return;
        }

        const currentRowId = bookingResult.rowId;

        const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
        if (adminId && !isNaN(adminId)) {
            const clientName = escapeHtml(ctx.from.first_name);
            const clientUser = ctx.from.username ? `@${escapeHtml(ctx.from.username)}` : 'нет юзернейма';

            const quickAdminKeyboard = new InlineKeyboard()
                .text('✅ Одобрить', `approve_app_${currentRowId}`)
                .text('❌ Отклонить', `reject_app_${currentRowId}`);

            const adminNoticeText = isRescheduling
                ? `🔄 <b>Запрос на ПЕРЕНЕСЕНИЕ записи!</b>\n\n`
                : `🔔 <b>Новая заявка на запись!</b>\n\n`;

            await ctx.api.sendMessage(
                adminId,
                adminNoticeText +
                `👤 <b>Клиент:</b> ${clientName} (${clientUser})\n` +
                `💅 <b>Услуга:</b> ${safeServiceName} (${selectedService.price} ₽)\n` +
                `📅 <b>Новая дата:</b> ${escapeHtml(displayDate)}\n` +
                `⏰ <b>Новое время:</b> ${escapeHtml(selectedTime)}\n\n` +
                `📥 Вы можете подтвердить или отклонить изменения кнопками ниже:`,
                { parse_mode: 'HTML', reply_markup: quickAdminKeyboard }
            ).catch((err) => console.error('[Notification Error] Не удалось отправить сообщение админу:', err));
        }

        const clientFinalText = isRescheduling
            ? `🎉 <b>Заявка на перенос успешно отправлена!</b>\n\n💅 <b>Услуга:</b> ${safeServiceName}\n📅 <b>Новое время:</b> ${escapeHtml(displayDate)} в ${escapeHtml(selectedTime)}\n\nАдминистратор проверит график и подтвердит изменения. Спасибо!`
            : `🎉 <b>Вы успешно записаны!</b>\n\n💅 <b>Услуга:</b> ${safeServiceName}\n📅 <b>Дата и время:</b> ${escapeHtml(displayDate)} в ${escapeHtml(selectedTime)}\n\nАдминистратор свяжется с вами для подтверждения. Спасибо!`;

        const mainMenu = await buildMainMenu(conversation, telegramId);
        await ctx.reply(clientFinalText, { parse_mode: 'HTML', reply_markup: mainMenu });

    } catch (error) {
        console.error('Ошибка внутри сценария записи:', error);
        await ctx.reply('⚠️ Произошла непредвиденная ошибка при бронировании. Пожалуйста, попробуйте запустить сценарий позже.');
    }
}

module.exports = { bookingConversation };
