const Database = require('better-sqlite3');
const path = require('path');

// Берем путь к базе данных из .env или ставим дефолтный
const dbPath = process.env.DB_PATH || './src/database/beauty_salon.sqlite';

// Инициализируем подключение к SQLite
// verbose: console.log позволяет видеть в консоли реальные SQL-запросы, которые выполняет бот (очень удобно для отладки)
const db = new Database(dbPath, { verbose: console.log });

// Включаем поддержку внешних ключей (Foreign Keys) для связей между таблицами
db.pragma('foreign_keys = ON');

console.log(`[Database] Успешное подключение к БД по пути: ${dbPath}`);

module.exports = db;
