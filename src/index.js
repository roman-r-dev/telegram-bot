require('dotenv').config();
const { Bot } = require('grammy');

// 1. Импортируем функцию инициализации базы данных и саму модель пользователей
const { initDatabase, UserModel } = require('./models/user.model');

// Проверяем токен
if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("Ошибка: Токен бота не найден в файле .env!");
    process.exit(1);
}

// 2. Запускаем инициализацию базы данных (проверит таблицы и создаст файл)
initDatabase();

// Создаем экземпляр бота
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// 3. Обработка команды /start с записью пользователя в SQLite
bot.command('start', (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || null;
    const firstName = ctx.from.first_name;

    try {
        // Записываем или обновляем данные пользователя в базе данных
        UserModel.upsertUser(telegramId, username, firstName);
        console.log(`[Bot] Пользователь ${firstName} (${telegramId}) успешно обработан в БД.`);
        
        // Отвечаем пользователю
        ctx.reply(`Привет, ${firstName}! Добро пожаловать в наш Салон Красоты.\n\nБаза данных успешно сохранила твой профиль. Скоро мы настроим меню записи!`);
    } catch (error) {
        console.error('Ошибка при сохранении пользователя в БД:', error);
        ctx.reply('Произошла ошибка при запуске бота. Пожалуйста, попробуйте позже.');
    }
});

// Запуск бота
console.log('Бот успешно запускается в режиме разработки...');
bot.start();
