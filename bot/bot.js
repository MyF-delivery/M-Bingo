// ============================================================
// M-BINGO TELEGRAM BOT - COMPLETE CHAT & MINI-APP INTEGRATION
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required!'); process.exit(1); }

const API_URL = process.env.API_URL || 'https://m-bingo-server.onrender.com';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '555508978';
const PORT = process.env.PORT || 3000;
const REFERRAL_BONUS = 20;

// Database
const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
});
pool.connect((err) => { if (err) console.error('❌ DB error:', err.stack); else console.log('✅ Database connected'); });

// Express (Required for Render)
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io' }));
app.use(express.json());
app.get('/health', async (req, res) => { res.json({ status: 'ok' }); });

const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });

// Helper Functions
async function getOrCreateUser(telegramId, firstName, lastName, username) {
    try {
        const response = await axios.post(`${API_URL}/api/users/register`, {
            telegramId, username: username || `user_${telegramId}`,
            firstName, lastName: lastName || '', referralCode: null
        }, { headers: { 'x-bot-token': BOT_TOKEN } });
        return response.data.user;
    } catch (error) { console.error('Reg error:', error.message); return null; }
}

async function getUserBalance(telegramId) {
    try {
        const r = await axios.get(`${API_URL}/api/wallet/${telegramId}`);
        return r.data.balance || 0;
    } catch (error) { return 0; }
}

function mainMenu(userId) {
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const buttons = [
        [{ text: "🎮 Play Game", callback_data: 'play' }],
        [{ text: "💰 Balance", callback_data: 'balance' }, { text: "🏦 Deposit", callback_data: 'deposit' }],
        [{ text: "📤 Withdraw", callback_data: 'withdraw' }, { text: "🔄 Transfer", callback_data: 'transfer' }],
        [{ text: "🎁 Invite", callback_data: 'invite' }, { text: "📖 Help", callback_data: 'help' }],
        [{ text: "📞 Support", callback_data: 'support' }]
    ];
    if (isAdmin) buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    return { reply_markup: { inline_keyboard: buttons } };
}

// Ensure User is Registered (Used before opening app)
async function ensureRegistered(telegramId, firstName, lastName, username) {
    try {
        const r = await axios.get(`${API_URL}/api/users/${telegramId}`);
        if (r.data.user) return true;
    } catch (e) {}
    const user = await getOrCreateUser(telegramId, firstName, lastName, username);
    return !!user;
}

// ============================================================
// COMMANDS
// ============================================================

// Start & Registration
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;
    const referralId = match ? parseInt(match[1]) : null;

    // Check if already registered
    const isRegistered = await ensureRegistered(userId, firstName, lastName, username);

    if (isRegistered) {
        // Process referral if present
        if (referralId && referralId !== userId) {
            try {
                await axios.post(`${API_URL}/api/referral/process`, { referrerId: referralId, newUserId: userId });
                await bot.sendMessage(referralId, `🎉 You earned ${REFERRAL_BONUS} Birr bonus! Someone registered using your referral link.`);
            } catch (e) {}
        }
        const balance = await getUserBalance(userId);
        await bot.sendMessage(chatId, `👋 Welcome back, ${firstName}!\n\n💰 Balance: ${balance} Birr`, {
            parse_mode: 'Markdown', ...mainMenu(userId)
        });
        return;
    }

    // New user: ask for contact
    const registerKeyboard = {
        reply_markup: { keyboard: [[{ text: "📱 Share Contact", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    };
    await bot.sendMessage(chatId, `📝 Welcome to M-BINGO, ${firstName}!\n\nPlease share your contact to register.`, { parse_mode: 'Markdown', ...registerKeyboard });
});

// Handle Contact
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const contact = msg.contact;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;

    if (!contact || contact.user_id != userId) return bot.sendMessage(chatId, '❌ Please share your own contact.');

    const registered = await ensureRegistered(userId, firstName, lastName, username);

    if (registered) {
        const balance = await getUserBalance(userId);
        await bot.sendMessage(chatId, '✅ Registration complete!', { reply_markup: { remove_keyboard: true } });
        await bot.sendMessage(chatId, `✅ Welcome, ${firstName}!\n💰 Balance: ${balance} Birr`, {
            parse_mode: 'Markdown', ...mainMenu(userId)
        });
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆕 New User: ${firstName} (${userId})`);
    } else {
        await bot.sendMessage(chatId, '❌ Registration failed. Please try again.');
    }
});

// Balance
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const balance = await getUserBalance(userId);
    await bot.sendMessage(chatId, `💰 *Your Balance:* ${balance} Birr`, { parse_mode: 'Markdown' });
});

// Play
bot.onText(/\/play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name;
    const lastName = msg.from.last_name || '';
    const username = msg.from.username;

    await ensureRegistered(userId, firstName, lastName, username);

    const stakeOptions = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "10 Birr", callback_data: 'stake_10' }, { text: "20 Birr", callback_data: 'stake_20' }],
                [{ text: "30 Birr", callback_data: 'stake_30' }, { text: "50 Birr", callback_data: 'stake_50' }],
                [{ text: "100 Birr", callback_data: 'stake_100' }, { text: "❌ Cancel", callback_data: 'cancel' }]
            ]
        }
    };
    await bot.sendMessage(chatId, '🎯 *Select your stake amount:*', { parse_mode: 'Markdown', ...stakeOptions });
});

// Deposit (Opens App Modal)
bot.onText(/\/deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
    const appUrl = `${GAME_URL}?mode=deposit&userId=${userId}`;
    await bot.sendMessage(chatId, '💰 *Deposit Section:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🏦 Open Deposit Form", web_app: { url: appUrl } }]] }
    });
});

// Withdraw (Opens App Modal)
bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
    const appUrl = `${GAME_URL}?mode=withdraw&userId=${userId}`;
    await bot.sendMessage(chatId, '🏦 *Withdrawal Section:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🏦 Open Withdraw Form", web_app: { url: appUrl } }]] }
    });
});

// Transfer (Keep in chat or open modal)
bot.onText(/\/transfer/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
    const appUrl = `${GAME_URL}?mode=transfer&userId=${userId}`;
    await bot.sendMessage(chatId, '🔄 *Transfer Section:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🔄 Open Transfer Form", web_app: { url: appUrl } }]] }
    });
});

// Invite (Fixed)
bot.onText(/\/invite/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;
    await bot.sendMessage(chatId, `🎁 *Invite Friends & Earn!*\n\nEarn *${REFERRAL_BONUS} Birr* per friend!\n\nYour Link:\n${inviteLink}`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "📤 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}` }],
                [{ text: "📋 Copy Link", callback_data: 'copy_invite' }]
            ]
        }
    });
});

// Help & Support
bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `📖 *Commands*\n/start - Start & Register\n/play - Play\n/balance - Check balance\n/deposit - Deposit\n/withdraw - Withdraw\n/transfer - Transfer\n/invite - Invite\n/support - Support`, { parse_mode: 'Markdown' });
});
bot.onText(/\/support/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '📞 *Support:* @frezerabiy\n📧 support@mbingo.com', { parse_mode: 'Markdown' });
});

// ============================================================
// CALLBACK QUERY HANDLER
// ============================================================
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    if (data.startsWith('stake_')) {
        const stake = parseInt(data.split('_')[1]);
        const appUrl = `${GAME_URL}?stake=${stake}&userId=${userId}`;
        await bot.sendMessage(chatId, `✅ Stake set to ${stake} Birr.\n\nClick below to select your cards:`, {
            reply_markup: { inline_keyboard: [[{ text: "🎮 Open Game", web_app: { url: appUrl } }]] }
        });
        return;
    }

    switch (data) {
        case 'play': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/play'); break;
        case 'balance': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance'); break;
        case 'deposit': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/deposit'); break;
        case 'withdraw': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/withdraw'); break;
        case 'transfer': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/transfer'); break;
        case 'invite': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/invite'); break;
        case 'help': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/help'); break;
        case 'support': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/support'); break;
        case 'copy_invite': {
            const link = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;
            await bot.sendMessage(chatId, `📋 ${link}`);
            break;
        }
        case 'cancel': await bot.sendMessage(chatId, '❌ Action cancelled.'); break;
    }
});

// Start Express & Bot
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Admin API on port ${PORT}`));
console.log('✅ M-BINGO Bot is running!');
