const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './src/database/beauty_salon.sqlite';

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

console.log(`[Database] Успешное подключение к БД по пути: ${dbPath}`);

module.exports = db;
