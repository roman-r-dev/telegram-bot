const cron = require('node-cron');
const db = require('../config/database');

function setupCronJobs(bot, helpers) {
    let isRunning = false;

    const formatMsk = (ms) => {
        const utc = ms + (new Date().getTimezoneOffset() * 60000);
        const d = new Date(utc + (3600000 * 3));
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:00`;
    };

    cron.schedule('* * * * *', async () => {
        if (isRunning) return;
        isRunning = true;

        try {
            const nowMs = Date.now();
            const targetStart = formatMsk(nowMs + (2 * 3600 * 1000) - 60000);
            const targetEnd = formatMsk(nowMs + (2 * 3600 * 1000) + 60000);

            const reminders = db.prepare(`
                SELECT a.id, a.user_id AS userId, a.appointment_date AS appointmentDate, s.name AS serviceName 
                FROM appointments a 
                JOIN services s ON a.service_id = s.id 
                WHERE a.appointment_date >= ?  
                  AND a.appointment_date <= ?  
                  AND a.status = 'confirmed'  
                  AND a.reminder_sent = 0
            `).all(targetStart, targetEnd);

            for (const app of reminders) {
                const formattedTime = helpers.extractTime(app.appointmentDate);

                const result = db.prepare(
                    "UPDATE appointments SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0"
                ).run(app.id);

                if (result.changes === 0) continue;

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
        } finally {
            isRunning = false;
        }
    });

    console.log('[Cron] Планировщик запущен.');
}

module.exports = { setupCronJobs };
