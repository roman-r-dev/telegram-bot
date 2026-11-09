# 1. Используем стабильный и оптимизированный образ Node.js на базе Debian Slim (вместо проблемного Alpine)
FROM node:18-slim

# 2. Устанавливаем инструменты сборки через apt-get (нужны для компиляции better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# 3. Создаем рабочую директорию внутри контейнера
WORKDIR /app

# 4. Копируем файлы зависимостей
COPY package*.json ./

# 5. Устанавливаем зависимости (включая правильную компиляцию better-sqlite3)
RUN npm install --omit=dev

# 6. Копируем весь остальной код проекта (благодаря .dockerignore мусор сюда не попадет)
COPY . .

# 7. Команда для запуска бота в продакшене
CMD ["npm", "start"]
