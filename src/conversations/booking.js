const { InlineKeyboard, Keyboard } = require('grammy');
const db = require('../config/database');

function getTargetDate(offsetHours = 3) {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc + (3600000 * offsetHours));
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
            
            const [oldRawDate, oldRawTime] = existingApp.appointment_date.split(' ');
            const oldDisplayDate = oldRawDate.split('-').reverse().join('.');

            const rescheduleKeyboard = new InlineKeyboard()
                .text('🔄 Да, перенести визит', 'action_reschedule').row()
                .text('❌ Нет, оставить как есть', 'action_cancel_flow');

            await clickContext.editMessageText(
                `🗓 <b>У вас уже есть активная запись на услугу "${selectedService.name}":</b>\n` +
                `📅 Дата: <b>${oldDisplayDate}</b> в <b>${oldRawTime}</b>.\n\n` +
                `Желаете перенести этот визит на другое время? Новому бронированию будет присвоен статус "В ожидании".`,
                { reply_markup: rescheduleKeyboard, parse_mode: 'HTML' }
            );

            let actionContext = await conversation.wait();
            while (!actionContext.callbackQuery || !['action_reschedule', 'action_cancel_flow'].includes(actionContext.callbackQuery.data)) {
                await actionContext.reply('Пожалуйста, выберите один из вариантов ниже.');
                actionContext = await conversation.wait();
            }

            await actionContext.answerCallbackQuery();

            if (actionContext.callbackQuery.data === 'action_cancel_flow') {
                const mainMenu = new Keyboard().text('📅 Записаться на услугу').text('🗂 Мои записи');
                const currentUserId = String(ctx.from?.id);
                if (db.prepare("SELECT role FROM users WHERE telegram_id = ?").get(currentUserId)?.role === 'admin' || currentUserId === String(process.env.ADMIN_TELEGRAM_ID)) {
                    mainMenu.row().text('🗓 Расписание на сегодня');
                }
                mainMenu.resized();

                await actionContext.editMessageText('👍 Отлично, ваша текущая запись остается в силе. Ждем вас в салоне!', { reply_markup: null });
                await ctx.reply('Вы вернулись в главное меню:', { reply_markup: mainMenu });
                return;
            }

            isRescheduling = true;
            clickContext = actionContext;
        }

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

        const step2Text = `Вы выбрали: *${selectedService.name}*.\n\n📅 Теперь выберите новый удобный день для визита:`;
        await clickContext.editMessageText(step2Text, { reply_markup: dateKeyboard, parse_mode: 'Markdown' });

        clickContext = await conversation.wait();

        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('date_')) {
            await clickContext.reply('Пожалуйста, выберите дату, нажав на одну из кнопок под сообщением.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();
        
        const selectedDate = clickContext.callbackQuery.data.replace('date_', ''); 
        const displayDate = selectedDate.split('-').reverse().join('.');
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
            return splitData[1] || '';
        });

        const allSalonSlots = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30', '19:00'];
        
        const timeKeyboard = new InlineKeyboard();
        let availableSlotsCount = 0;

        const nowTarget = getTargetDate(3);
        const todayStr = `${nowTarget.getFullYear()}-${String(nowTarget.getMonth() + 1).padStart(2, '0')}-${String(nowTarget.getDate()).padStart(2, '0')}`;
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
            const mainMenu = new Keyboard().text('📅 Записаться на услугу').text('🗂 Мои записи');
            const currentUserId = String(ctx.from?.id);
            if (db.prepare("SELECT role FROM users WHERE telegram_id = ?").get(currentUserId)?.role === 'admin' || currentUserId === String(process.env.ADMIN_TELEGRAM_ID)) {
                mainMenu.row().text('🗓 Расписание на сегодня');
            }
            mainMenu.resized();

            await clickContext.editMessageText(
                `😔 К сожалению, на выбранную дату (<b>${displayDate}</b>) свободные места закончились или рабочее время салона вышло.\n\n` +
                `Пожалуйста, начните сначала и выберите другой день.`, 
                { parse_mode: 'HTML', reply_markup: null }
            );
            await ctx.reply('Вы вернулись в меню:', { reply_markup: mainMenu });
            return;
        }

        await clickContext.editMessageText(
            `Отлично, дата выбрана: *${displayDate}* \n\n⏰ Выберите удобное время для визита:`,
            { reply_markup: timeKeyboard, parse_mode: 'Markdown' }
        );

        clickContext = await conversation.wait();

        while (!clickContext.callbackQuery || !clickContext.callbackQuery.data.startsWith('time_')) {
            await clickContext.reply('Пожалуйста, выберите время, нажав на одну из кнопок ниже.');
            clickContext = await conversation.wait();
        }

        await clickContext.answerCallbackQuery();
        const selectedTime = clickContext.callbackQuery.data.replace('time_', '');

        let currentRowId = appointmentIdToUpdate;
        const fullDateTime = `${selectedDate} ${selectedTime}`;

        await conversation.external(() => {
            if (isRescheduling) {
                const stmt = db.prepare(`
                    UPDATE appointments 
                    SET appointment_date = ?, status = 'pending' 
                    WHERE id = ?
                `);
                return stmt.run(fullDateTime, appointmentIdToUpdate);
            } else {
                const stmt = db.prepare(`
                    INSERT INTO appointments (user_id, service_id, appointment_date, status)
                    VALUES (?, ?, ?, 'pending')
                `);
                const result = stmt.run(telegramId, serviceId, fullDateTime);
                currentRowId = result.lastInsertRowid;
                return result;
            }
        });

        await clickContext.editMessageText(`Вы выбрали время: *${selectedTime}*. Оформляю изменения... ⏳`, { parse_mode: 'Markdown', reply_markup: null });

        const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
        if (adminId && !isNaN(adminId)) {
            const clientName = ctx.from.first_name;
            const clientUser = ctx.from.username ? `@${ctx.from.username}` : 'нет юзернейма';
            
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
                `💅 <b>Услуга:</b> ${selectedService.name} (${selectedService.price} ₽)\n` +
                `📅 <b>Новая дата:</b> ${displayDate}\n` +
                `⏰ <b>Новое время:</b> ${selectedTime}\n\n` +
                `📥 Вы можете подтвердить или отклонить изменения кнопками ниже:`,
                { parse_mode: 'HTML', reply_markup: quickAdminKeyboard }
            ).catch((err) => console.error('[Notification Error] Не удалось отправить сообщение админу:', err));
        }

        const clientFinalText = isRescheduling
            ? `🎉 *Заявка на перенос успешно отправлена!* \n\n💅 *Услуга:* ${selectedService.name}\n📅 *Новое время:* ${displayDate} в ${selectedTime}\n\nАдминистратор проверит график и подтвердит изменения. Спасибо!`
            : `🎉 *Вы успешно записаны!* \n\n💅 *Услуга:* ${selectedService.name}\n📅 *Дата и время:* ${displayDate} в ${selectedTime}\n\nАдминистратор свяжется с вами для подтверждения. Спасибо!`;

        const mainMenu = new Keyboard().text('📅 Записаться на услугу').text('🗂 Мои записи');
        const currentUserId = String(ctx.from?.id);
        
        if (db.prepare("SELECT role FROM users WHERE telegram_id = ?").get(currentUserId)?.role === 'admin' || currentUserId === String(process.env.ADMIN_TELEGRAM_ID)) {
            mainMenu.row().text('🗓 Расписание на сегодня');
        }
        mainMenu.resized();

        await ctx.reply(clientFinalText, { parse_mode: 'Markdown', reply_markup: mainMenu });

    } catch (error) {
        console.error('Ошибка внутри сценария записи:', error);
        await ctx.reply('⚠️ Произошла непредвиденная ошибка при бронировании. Пожалуйста, попробуйте запустить сценарий позже.');
    }
}

module.exports = { bookingConversation };
