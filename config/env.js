// config/env.js
require('dotenv').config();

const required = [
  'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'BOT_TOKEN', 'ADMIN_TELEGRAM_ID'
];

const optional = {
  PORT: 3000,
  API_URL: 'https://m-bingo-server.onrender.com',
  GAME_URL: 'https://myf-delivery.github.io/M-Bingo/',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'admin123',
  ADMIN_PASSWORD_HASH: '',
  BINGO_CALL_INTERVAL_MS: 10000,
  BINGO_SELECTION_SECONDS: 60,
  BINGO_MIN_PLAYERS: 2,
  REFERRAL_BONUS: 20,
  ALLOW_BROWSER_TESTING: 'false',
  CORS_ORIGIN: 'https://myf-delivery.github.io'
};

for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const config = {
  ...optional,
  ...process.env,
  PORT: Number(process.env.PORT || optional.PORT),
  BINGO_CALL_INTERVAL_MS: Number(process.env.BINGO_CALL_INTERVAL_MS || optional.BINGO_CALL_INTERVAL_MS),
  BINGO_SELECTION_SECONDS: Number(process.env.BINGO_SELECTION_SECONDS || optional.BINGO_SELECTION_SECONDS),
  BINGO_MIN_PLAYERS: Number(process.env.BINGO_MIN_PLAYERS || optional.BINGO_MIN_PLAYERS),
  REFERRAL_BONUS: Number(process.env.REFERRAL_BONUS || optional.REFERRAL_BONUS),
  ALLOW_BROWSER_TESTING: String(process.env.ALLOW_BROWSER_TESTING || optional.ALLOW_BROWSER_TESTING).toLowerCase() === 'true',
};

module.exports = config;
