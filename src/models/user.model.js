const db = require('../config/database');

function initDatabase() {
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

    db.prepare(`
        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price INTEGER NOT NULL,
            duration TEXT DEFAULT '1 час'
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS masters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            specialty TEXT
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            service_id INTEGER,
            master_id INTEGER,
            appointment_date TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            reminder_sent INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (telegram_id) ON DELETE CASCADE,
            FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
            FOREIGN KEY (master_id) REFERENCES masters (id) ON DELETE CASCADE
        )
    `).run();

    const countServices = db.prepare('SELECT COUNT(*) as count FROM services').get();
    if (countServices.count === 0) {
        const insertService = db.prepare('INSERT INTO services (name, price, duration) VALUES (?, ?, ?)');
        const insertManyServices = db.transaction((services) => {
            for (const service of services) {
                insertService.run(service.name, service.price, service.duration);
            }
        });

        insertManyServices([
            { name: 'Мужская стрижка', price: 1200, duration: '45 мин' },
            { name: 'Женская стрижка', price: 2000, duration: '1 час' },
            { name: 'Маникюр с покрытием', price: 1800, duration: '1.5 часа' },
            { name: 'Уход за бородой', price: 800, duration: '30 мин' }
        ]);
        console.log('[Database] Сервисы инициализированы.');
    }

    const countMasters = db.prepare('SELECT COUNT(*) as count FROM masters').get();
    if (countMasters.count === 0) {
        const insertMaster = db.prepare('INSERT INTO masters (name, specialty) VALUES (?, ?)');
        const insertManyMasters = db.transaction((masters) => {
            for (const master of masters) {
                insertMaster.run(master.name, master.specialty);
            }
        });

        insertManyMasters([
            { name: 'Алексей', specialty: 'Топ-Барбер' },
            { name: 'Мария', specialty: 'Стилист' },
            { name: 'Елена', specialty: 'Мастер маникюра' }
        ]);
        console.log('[Database] Мастера инициализированы.');
    }

    try {
        db.prepare("ALTER TABLE appointments ADD COLUMN reminder_sent INTEGER DEFAULT 0").run();
        console.log('[Database] Структура таблиц обновлена.');
    } catch (err) {
        if (!err.message.includes('duplicate column name')) {
            console.error('Ошибка миграции БД:', err.message);
        }
    }

    console.log('[Database] База данных готова к работе.');
}

const UserModel = {
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
