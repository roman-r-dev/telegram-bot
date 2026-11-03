require('dotenv').config();
// 1. Добавляем Keyboard для создания обычных кнопок внизу экрана
const { Bot, session, Keyboard } = require('grammy'); 
// 2. Добавляем createConversation для регистрации нашего сценария
const { conversations, createConversation } = require('@grammyjs/conversations');

// Импортируем функцию инициализации базы данных и саму модель пользователей
const { initDatabase, UserModel } = require('./models/user.model');

// 3. ИМПОРТ НАШЕГО НОВОГО СЦЕНАРИЯ ЗАПИСИ
const { bookingConversation } = require('./conversations/booking');

// Проверяем токен
if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("Ошибка: Токен бота не найден в файле .env!");
    process.exit(1);
}

// Запускаем инициализацию базы данных (ваш существующий код)
initDatabase();

// Создаем экземпляр бота
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Подключаем базовые сессии (выделяем память для каждого пользователя)
bot.use(session({
    initial: () => ({})
}));

// Подключаем сам плагин разговоров поверх сессий
bot.use(conversations());

// 4. РЕГИСТРИРУЕМ СЦЕНАРИЙ ЗАПИСИ В БОТЕ
bot.use(createConversation(bookingConversation));

// Обработка команды /start с записью пользователя в SQLite
bot.command('start', (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || null;
    const firstName = ctx.from.first_name;

    try {
        // Записываем или обновляем данные пользователя в базе данных
        UserModel.upsertUser(telegramId, username, firstName);
        console.log(`[Bot] Пользователь ${firstName} (${telegramId}) успешно обработан в БД.`);
        
        // 5. Создаем красивую кнопку "Записаться на услугу" под полем ввода текста
        const mainMenu = new Keyboard()
            .text('📅 Записаться на услугу')
            .resized(); // Делает кнопку компактной, а не огромной

        // Отвечаем пользователю и прикрепляем клавиатуру
        ctx.reply(
            `Привет, ${firstName}! Добро пожаловать в наш Салон Красоты. ✨\n\n` +
            `База данных успешно сохранила твой профиль. Нажми на кнопку ниже, чтобы записаться!`, 
            { reply_markup: mainMenu }
        );
    } catch (error) {
        console.error('Ошибка при сохранении пользователя в БД:', error);
        ctx.reply('Произошла ошибка при запуске бота. Пожалуйста, попробуйте позже.');
    }
});

// 6. ХЭНДЛЕР ДЛЯ ЗАПУСКА РАЗГОВОРА ПО КНОПКЕ
bot.hears('📅 Записаться на услугу', async (ctx) => {
    // Входим в наш пошаговый сценарий, который мы зарегистрировали выше
    await ctx.conversation.enter('bookingConversation');
});

// Запуск бота
console.log('Бот успешно запускается в режиме разработки...');
bot.start();
