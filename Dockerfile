# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Копируем package files
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci

# Копируем исходники
COPY . .

# Собираем TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Копируем package files
COPY package*.json ./

# Устанавливаем только production зависимости
RUN npm ci --only=production

# Копируем собранный код
COPY --from=builder /app/dist ./dist

# Копируем Lua скрипты
COPY --from=builder /app/lua ./lua

# Копируем статику
COPY --from=builder /app/public ./public

# Порт
EXPOSE 3000

# Запуск
CMD ["node", "dist/index.js"]
