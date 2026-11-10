require('dotenv').config();
const { Bot, session } = require('grammy'); 
const { conversations, createConversation } = require('@grammyjs/conversations');

const { initDatabase } = require('./models/user.model');
const { bookingConversation } = require('./conversations/booking');

const { registerClientHandlers } = require('./handlers/client.handlers');
const { registerAdminHandlers } = require('./handlers/admin.handlers');
const { setupCronJobs } = require('./jobs/reminder.cron');

if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("Ошибка: Токен бота не найден в файле .env!");
    process.exit(1);
}

initDatabase();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session({
    initial: () => ({})
}));

bot.use(conversations());
bot.use(createConversation(bookingConversation));

bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[Error] Ошибка при обработке обновления ${ctx.update.update_id}:`);
    console.error(err.error);
});

const helpers = {
    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },

    extractTime(dateTimeStr) {
        if (!dateTimeStr) return '00:00';
        const parts = dateTimeStr.split(' ');
        if (parts.length < 2 || !parts[1]) return '00:00';
        return parts[1].substring(0, 5); 
    },

    formatDate(dateStr) {
        if (!dateStr) return 'Не указана';
        const parts = dateStr.split(' '); 
        const rawDate = parts[0];
        return rawDate.split('-').reverse().join('.');
    },

    getTargetDateTimeString(offsetHours = 3) {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const targetDate = new Date(utc + (3600000 * offsetHours));
        
        const YYYY = targetDate.getFullYear();
        const MM = String(targetDate.getMonth() + 1).padStart(2, '0');
        const DD = String(targetDate.getDate()).padStart(2, '0');
        const HH = String(targetDate.getHours()).padStart(2, '0');
        const mm = String(targetDate.getMinutes()).padStart(2, '0');
        
        return `${YYYY}-${MM}-${DD} ${HH}:${mm}:00`;
    }
};

registerClientHandlers(bot, helpers);
registerAdminHandlers(bot, helpers);
setupCronJobs(bot, helpers);

console.log('Бот успешно запускается...');
bot.start();
