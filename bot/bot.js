// ============================================================
// M-BINGO TELEGRAM BOT - FULL FEATURED (FIXED)
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// CONFIGURATION
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is required!');
    process.exit(1);
}

const API_URL = process.env.API_URL || 'https://m-bingo-server.onrender.com';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '555508978';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const PORT = process.env.PORT || 3000;
const REFERRAL_BONUS = 20;

console.log('🤖 M-BINGO Bot Configuration:');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎮 Game URL: ${GAME_URL}`);
console.log(`👑 Admin ID: ${ADMIN_TELEGRAM_ID}`);

// DATABASE CONNECTION
const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) console.error('❌ DB error:', err.stack);
    else console.log('✅ Database connected');
});

// EXPRESS SERVER
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io' }));
app.use(express.json());

// ... [Keep all your existing Express Admin API routes here] ...

// TELEGRAM BOT
const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });

// HELPERS
async function getOrCreateUser(telegramId, firstName, lastName, username, referralCode) {
    try {
        // FIX: Added headers to send the BOT_TOKEN so the main server can authorize it
        const response = await axios.post(`${API_URL}/api/users/register`, {
            telegramId,
            username: username || `user_${telegramId}`,
            firstName,
            lastName: lastName || '',
            referralCode: referralCode || null
        }, {
            headers: { 'x-bot-token': BOT_TOKEN } 
        });
        return response.data.user;
    } catch (error) {
        console.error('Registration error:', error.response?.data?.message || error.message);
        return null;
    }
}

async function getUserBalance(telegramId) {
    try {
        const response = await axios.get(`${API_URL}/api/wallet/${telegramId}`);
        return response.data.balance || 0;
    } catch (error) {
        return 0;
    }
}

function formatCurrency(amount) {
    return amount.toLocaleString('en-US') + ' ETB';
}

// MAIN MENU
function mainMenu(userId) {
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const buttons = [
        [{ text: "🎮 Play Game", callback_data: 'play' }],
        [
            { text: "💰 Balance", callback_data: 'balance' },
            { text: "🏦 Deposit", callback_data: 'deposit' }
        ],
        [
            { text: "📤 Withdraw", callback_data: 'withdraw' },
            { text: "🔄 Transfer", callback_data: 'transfer' }
        ],
        [
            { text: "🎁 Bonus / Invite", callback_data: 'bonus' },
            { text: "📜 History", callback_data: 'history' }
        ],
        [
            { text: "📖 Help", callback_data: 'help' },
            { text: "📞 Support", callback_data: 'support' }
        ],
        [
            { text: "🏆 Patterns", callback_data: 'patterns' },
            { text: "👤 Profile", callback_data: 'profile' }
        ]
    ];
    if (isAdmin) {
        buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    }
    return { reply_markup: { inline_keyboard: buttons } };
}

// COMMANDS AND HANDLERS
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;
    const referralId = match ? parseInt(match[1]) : null;

    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            const balance = await getUserBalance(userId);
            const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
            const welcomeBack = `👋 *Welcome back, ${firstName}!*${isAdmin ? ' 👑' : ''}\n\n` +
                `💰 *Balance:* ${formatCurrency(balance)}\n` +
                `👇 *Select an option below:*`;
            await bot.sendMessage(chatId, welcomeBack, {
                parse_mode: 'Markdown',
                ...mainMenu(userId)
            });
            return;
        }
    } catch (error) {
        console.log('New user registration flow');
    }

    const registerMessage = `
📝 *Welcome to M-BINGO, ${firstName}!*

To complete your registration, please share your contact by clicking the button below.

🔒 *Your Telegram ID will be used to securely identify you.*
    `;
    const registerKeyboard = {
        reply_markup: {
            keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    };
    await bot.sendMessage(chatId, registerMessage, {
        parse_mode: 'Markdown',
        ...registerKeyboard
    });
    bot._referralMap = bot._referralMap || {};
    bot._referralMap[userId] = referralId;
});

// Handle contact sharing
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const contact = msg.contact;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;

    if (!contact || contact.user_id != userId) {
        await bot.sendMessage(chatId, '❌ Please share your own contact.');
        return;
    }

    // FIX: Check if already registered right away to prevent duplicate call errors
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            await bot.sendMessage(chatId, '✅ You are already registered!');
            await bot.sendMessage(chatId, '🎯 *Welcome back!*', {
                parse_mode: 'Markdown',
                ...mainMenu(userId)
            });
            return;
        }
    } catch (error) {}

    const referralId = bot._referralMap ? bot._referralMap[userId] : null;

    const user = await getOrCreateUser(userId, firstName, lastName, username, referralId);

    // FIX: Added the else block to handle failed/duplicate attempts cleanly
    if (user) {
        if (referralId) {
            try {
                await axios.post(`${API_URL}/api/referral/process`, {
                    referrerId: referralId,
                    newUserId: userId
                });
                await bot.sendMessage(referralId, `🎉 You earned ${REFERRAL_BONUS} Birr bonus! Someone registered using your referral link.`);
            } catch (e) {}
        }
        const welcome = `✅ *Registration Successful!*\n\n` +
            `🎯 Welcome to M-BINGO, ${firstName}!\n` +
            `💰 You have received a *50 Birr* starting balance.\n\n` +
            `👇 *Select an option below to start playing!*`;
        await bot.sendMessage(chatId, '✅ Registration complete!', {
            reply_markup: { remove_keyboard: true }
        });
        await bot.sendMessage(chatId, welcome, {
            parse_mode: 'Markdown',
            ...mainMenu(userId)
        });
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆕 *New User Registered!*\n\n` +
            `👤 Name: ${firstName}\n🆔 ID: ${userId}\n📱 Username: @${username || 'N/A'}\n📞 Phone: ${contact.phone_number}`);
    } else {
        // Fallback: If it fails, it's likely because they already registered. Show menu.
        await bot.sendMessage(chatId, '✅ You are already registered!');
        await bot.sendMessage(chatId, '🎯 *Welcome back!*', {
            parse_mode: 'Markdown',
            ...mainMenu(userId)
        });
    }
});

// ... [Keep all other command handlers like /play, /deposit, /withdraw, etc.] ...

// START SERVER & BOT
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Admin API on port ${PORT}`);
});

bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: '🎮 Play M-BINGO', web_app: { url: GAME_URL } }
}).catch(() => {});

console.log('✅ M-BINGO Bot is running!');
