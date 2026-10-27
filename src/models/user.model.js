const db = require('../config/database');

function initDatabase() {
    // 1. Создаем таблицу пользователей салона
    db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            phone TEXT,
            role TEXT DEFAULT 'client',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // 2. Создаем таблицу услуг (прайс-лист)
    db.prepare(`
        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price INTEGER NOT NULL,
            duration TEXT DEFAULT '1 час'
        )
    `).run();

    // 3. Создаем таблицу записей клиентов
    db.prepare(`
        CREATE TABLE IF NOT EXISTS appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            service_id INTEGER,
            appointment_date TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (telegram_id) ON DELETE CASCADE,
            FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE
        )
    `).run();

    // Заполняем базу базовыми услугами, если она пустая
    const countServices = db.prepare('SELECT COUNT(*) as count FROM services').get();
    if (countServices.count === 0) {
        const insertService = db.prepare('INSERT INTO services (name, price, duration) VALUES (?, ?, ?)');
        
        const insertMany = db.transaction((services) => {
            for (const service of services) {
                insertService.run(service.name, service.price, service.duration);
            }
        });

        insertMany([
            { name: 'Мужская стрижка', price: 1200, duration: '45 мин' },
            { name: 'Женская стрижка', price: 2000, duration: '1 час' },
            { name: 'Маникюр с покрытием', price: 1800, duration: '1.5 часа' },
            { name: 'Уход за бородой', price: 800, duration: '30 мин' }
        ]);
        console.log('[Database] Тестовые услуги добавлены в прайс-лист!');
    }

    console.log('[Database] Все таблицы проверены и готовы к работе.');
}

// Функции-помощники для работы с данными
const UserModel = {
    // Метод регистрации/обновления юзера в базе
    upsertUser(telegramId, username, firstName) {
        const query = db.prepare(`
            INSERT INTO users (telegram_id, username, first_name)
            VALUES (?, ?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET
                username = excluded.username,
                first_name = excluded.first_name
        `);
        return query.run(telegramId, username, firstName);
    }
};

module.exports = { initDatabase, UserModel };
