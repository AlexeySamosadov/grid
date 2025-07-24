import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

// Загружаем переменные из .env
dotenv.config();

// Ваш токен бота и chat_id из .env файла
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

// Создаем экземпляр бота
const bot = new TelegramBot(token);

// Функция для отправки сообщений в группу
export function logAndSendMessage(message) {
    // Логируем сообщение в консоль
    console.log(message);

    // Отправляем сообщение в Telegram
    bot.sendMessage(chatId, message)
        .catch(err => console.error('Ошибка отправки сообщения в Telegram:', err));
}

