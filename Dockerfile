# 1. Используем стабильный и легковесный образ Node.js
FROM node:18-alpine

# 2. Устанавливаем инструменты сборки (нужны для компиляции better-sqlite3 на Linux)
RUN apk add --no-cache python3 make g++

# 3. Создаем рабочую директорию внутри контейнера
WORKDIR /app

# 4. Копируем файлы зависимостей
COPY package*.json ./

# 5. Устанавливаем зависимости (включая компиляцию better-sqlite3)
RUN npm install --omit=dev

# 6. Копируем весь остальной код проекта (кроме того, что в .gitignore)
COPY . .

# 7. Команда для запуска бота в продакшене
CMD ["npm", "start"]
