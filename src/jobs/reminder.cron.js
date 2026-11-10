const cron = require('node-cron');
const db = require('../config/database');

function setupCronJobs(bot, helpers) {
    cron.schedule('* * * * *', async () => {
        try {
            const currentMskTime = helpers.getTargetDateTimeString(3);
            const isoString = currentMskTime.replace(' ', 'T');
            const mskDate = new Date(isoString);

            if (isNaN(mskDate.getTime())) {
                return;
            }

            const targetStart = new Date(mskDate.getTime() + (2 * 3600 * 1000) - 60000);
            const targetEnd = new Date(mskDate.getTime() + (2 * 3600 * 1000) + 60000);

            const toDbFormat = (d) => {
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
            };

            const reminders = db.prepare(`
                SELECT a.id, a.user_id AS userId, a.appointment_date AS appointmentDate, s.name AS serviceName 
                FROM appointments a 
                JOIN services s ON a.service_id = s.id 
                WHERE a.appointment_date >= ?  
                  AND a.appointment_date <= ?  
                  AND a.status = 'confirmed'  
                  AND a.reminder_sent = 0
            `).all(toDbFormat(targetStart), toDbFormat(targetEnd));

            for (const app of reminders) {
                const formattedTime = helpers.extractTime(app.appointmentDate);

                db.prepare("UPDATE appointments SET reminder_sent = 1 WHERE id = ?").run(app.id);

                await bot.api.sendMessage(
                    String(app.userId),
                    `⏰ <b>Напоминание о визите!</b>\n\n` +
                    `Ждем вас сегодня через 2 часа в <b>${formattedTime}</b> на услугу <b>${helpers.escapeHtml(app.serviceName)}</b>. ✨`,
                    { parse_mode: 'HTML' }
                ).catch((err) => {
                    console.error(`[Cron] Ошибка отправки ${app.userId}:`, err.message);
                });

                await new Promise(resolve => setTimeout(resolve, 150));
            }
        } catch (error) {
            console.error('Ошибка планировщика:', error);
        }
    });

    console.log('[Cron] Планировщик запущен.');
}

module.exports = { setupCronJobs };
