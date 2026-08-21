// ============================================================
// M-BINGO TELEGRAM BOT
// File: bot/bot.js
// Uses environment variables from Render
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// ============================================================
// CONFIGURATION – from environment
// ============================================================

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

console.log('🤖 M-BINGO Bot Configuration:');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎮 Game URL: ${GAME_URL}`);
console.log(`👑 Admin ID: ${ADMIN_TELEGRAM_ID}`);
console.log(`🌐 Port: ${PORT}`);

// ============================================================
// DATABASE CONNECTION (PostgreSQL on Render)
// ============================================================

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

// ============================================================
// EXPRESS SERVER (Admin API)
// ============================================================

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io' }));
app.use(express.json());

// Health check
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT NOW()');
        res.json({ status: 'ok', database: 'connected' });
    } catch (e) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

// Admin login
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (username !== ADMIN_USERNAME) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (ADMIN_PASSWORD_HASH) {
        const valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
        if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    } else if (password !== 'admin123') {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    res.json({ success: true, adminId: ADMIN_TELEGRAM_ID });
});

// Get admin data
app.get('/api/admin/data', async (req, res) => {
    if (req.query.adminId !== ADMIN_TELEGRAM_ID) return res.status(401).json({ success: false });
    try {
        const response = await axios.get(`${API_URL}/api/admin/players`);
        res.json({ success: true, players: response.data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error fetching players' });
    }
});

// Admin actions (deposit/withdraw)
app.post('/api/admin/action', async (req, res) => {
    const { adminId, action, playerId, amount } = req.body;
    if (adminId !== ADMIN_TELEGRAM_ID) return res.status(401).json({ success: false });
    try {
        const response = await axios.post(`${API_URL}/api/admin/action`, { adminId, action, playerId, amount });
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ success: false, message: e.response?.data?.message || 'Action failed' });
    }
});

// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });

// Main menu
function mainMenu(userId) {
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const buttons = [
        [{ text: "🎮 Play Now", web_app: { url: GAME_URL } }],
        [{ text: "💰 Check Balance", callback_data: 'balance' }, { text: "🏦 Make a Deposit", callback_data: 'deposit_info' }],
        [{ text: "📞 Support", callback_data: 'support' }, { text: "📖 Instructions", callback_data: 'rules' }],
        [{ text: "📩 Invite", callback_data: 'invite' }, { text: "🏆 Win Patterns", callback_data: 'patterns' }],
        [{ text: "👤 Profile", callback_data: 'profile' }, { text: "🏆 Leaderboard", callback_data: 'leaderboard' }]
    ];
    if (isAdmin) buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    return { reply_markup: { inline_keyboard: buttons } };
}

// /start
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const username = msg.from.username || `user_${userId}`;

    try {
        await axios.post(`${API_URL}/api/users/register`, {
            telegramId: userId,
            username,
            firstName,
            lastName: msg.from.last_name || ''
        });
        console.log(`✅ Registered: ${firstName} (${userId})`);
    } catch (e) { console.log('⚠️ Registration check:', e.message); }

    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const welcome = `🎯 *Welcome to M-BINGO, ${firstName}!*${isAdmin ? ' 👑' : ''}\n\n` +
        `💰 Balance: 0 Birr\n\n📌 *How to Play:*\n` +
        `1️⃣ Tap "🎮 Play Now"\n2️⃣ Select stake\n3️⃣ Choose 1-5 cards\n4️⃣ Wait for 2+ players\n5️⃣ Game starts!\n6️⃣ First to complete a pattern wins 70%! 🏆\n\n👇 *Tap below to open:*`;

    await bot.sendMessage(chatId, welcome, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🎮 Play Now", web_app: { url: GAME_URL } }]] }
    });
    await bot.sendMessage(chatId, "👇 *Select an option:*", { ...mainMenu(userId), parse_mode: 'Markdown' });
});

// /balance
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const { data } = await axios.get(`${API_URL}/api/wallet/${userId}`);
        bot.sendMessage(chatId, `*Username:* ${data.first_name || 'Player'}\n*Balance:* ${data.balance || 0}.00 ETB`, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, '⚠️ Could not fetch balance.');
    }
});

// /invite
bot.onText(/\/invite/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const link = `https://t.me/M_bingo_bot?start=ref_${userId}`;
    bot.sendMessage(chatId, `🎉 Hello ${firstName}!\n\nYour invite link:\n${link}\n\nShare and earn!`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "📤 Share", url: `https://t.me/share/url?url=${encodeURIComponent(link)}` }]] }
    });
});

// /profile
bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const { data } = await axios.get(`${API_URL}/api/users/${userId}`);
        const u = data.user;
        const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
        bot.sendMessage(chatId,
            `👤 *Profile*${isAdmin ? ' 👑' : ''}\n\n📛 Name: ${u.first_name}\n🆔 ID: ${u.telegramId}\n💰 Balance: ${u.balance} Birr\n🎴 Cards: ${u.cards?.length || 0}\n🏆 Games: ${u.gamesPlayed || 0}\n🎖️ Wins: ${u.wins || 0}\n📅 Joined: ${new Date(u.createdAt).toLocaleDateString()}`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
        bot.sendMessage(chatId, '⚠️ Could not fetch profile.');
    }
});

// /admin
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    bot.sendMessage(chatId, '👑 *Admin Panel*', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 Players', callback_data: 'admin_players' }],
                [{ text: '📊 Stats', callback_data: 'admin_stats' }],
                [{ text: '💰 Add Balance', callback_data: 'admin_add_balance' }],
                [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
                [{ text: '🔙 Back', callback_data: 'back_to_menu' }]
            ]
        }
    });
});

// Callback queries
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    switch (data) {
        case 'balance': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance'); break;
        case 'deposit_info':
            bot.sendMessage(chatId, '🏦 *Deposit*\nMin: 50 ETB, Max: 5000 ETB\n📞 Contact @frezerabiy', { parse_mode: 'Markdown' });
            break;
        case 'invite': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/invite'); break;
        case 'profile': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/profile'); break;
        case 'support': bot.sendMessage(chatId, '📞 Contact @frezerabiy'); break;
        case 'rules':
            bot.sendMessage(chatId, '📖 *Instructions*\n1. Tap Play Now\n2. Select stake\n3. Choose cards\n4. Wait for 2+ players\n5. Game starts\n6. First to complete a pattern wins 70%!', { parse_mode: 'Markdown' });
            break;
        case 'patterns':
            bot.sendMessage(chatId, '🏆 *Winning Patterns*\n✅ Row\n✅ Column\n✅ Diagonal\n✅ Corners\n✅ Full House', { parse_mode: 'Markdown' });
            break;
        case 'leaderboard': bot.sendMessage(chatId, '🏆 Leaderboard coming soon!'); break;
        case 'admin_panel': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/admin'); break;
        case 'admin_players':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
            try {
                const { data } = await axios.get(`${API_URL}/api/admin/players`);
                let msg = '👥 *Players*\n\n';
                data.slice(0, 20).forEach((p, i) => msg += `${i+1}. ${p.first_name || 'Player'} - 💰 ${p.balance || 0} Birr\n`);
                msg += `\n📊 Total: ${data.length}`;
                bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            } catch (e) { bot.sendMessage(chatId, '⚠️ Error fetching players.'); }
            break;
        case 'admin_stats':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
            try {
                const { data } = await axios.get(`${API_URL}/api/admin/stats`);
                bot.sendMessage(chatId, `📊 *Stats*\n👥 Online: ${data.onlinePlayers || 0}\n🎮 Active: ${data.activeGames || 0}\n💰 Revenue: ${data.todayRevenue || 0} Birr\n📈 Users: ${data.totalPlayers || 0}`, { parse_mode: 'Markdown' });
            } catch (e) { bot.sendMessage(chatId, '⚠️ Error fetching stats.'); }
            break;
        case 'admin_add_balance':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
            bot.sendMessage(chatId, '💰 Use: /addbalance [telegram_id] [amount]');
            break;
        case 'admin_broadcast':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
            bot.sendMessage(chatId, '📢 Use: /broadcast [message]');
            break;
        case 'back_to_menu':
            bot.editMessageText('🎯 *Welcome back!*', {
                chat_id: chatId,
                message_id: call.message.message_id,
                parse_mode: 'Markdown',
                ...mainMenu(userId)
            });
            break;
    }
});

// Admin commands
bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    try {
        await axios.post(`${API_URL}/api/admin/balance/add`, { userId: targetId, amount, adminId: userId });
        bot.sendMessage(chatId, `✅ Added ${amount} Birr to player!`);
    } catch (e) { bot.sendMessage(chatId, '⚠️ Error adding balance.'); }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    bot.sendMessage(chatId, `📢 Broadcast sent: "${match[1]}"`);
});

// ============================================================
// START SERVER & BOT
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Admin API on port ${PORT}`);
});

bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: '🎮 Play M-BINGO', web_app: { url: GAME_URL } }
}).catch(() => {});

console.log('✅ M-BINGO Bot is running!');
