// ============================================================
// M-BINGO TELEGRAM BOT - COMPLETE CHAT & ADMIN PANEL
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// ============================================================
// CONFIGURATION
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
const REFERRAL_BONUS = 20;

// ============================================================
// DATABASE CONNECTION
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

app.get('/health', async (req, res) => {
    try { await pool.query('SELECT NOW()'); res.json({ status: 'ok', database: 'connected' }); }
    catch (e) { res.status(500).json({ status: 'error', database: 'disconnected' }); }
});

// ============================================================
// TELEGRAM BOT
// ============================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });

// User Session State
const userState = {};
const adminLoginState = {};

// ============================================================
// HELPERS
// ============================================================
async function getOrCreateUser(telegramId, firstName, lastName, username, referralCode) {
    try {
        const response = await axios.post(`${API_URL}/api/users/register`, {
            telegramId,
            username: username || `user_${telegramId}`,
            firstName,
            lastName: lastName || '',
            referralCode: referralCode || null
        }, { headers: { 'x-bot-token': BOT_TOKEN } }); // FIXED: Added token
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
    } catch (error) { return 0; }
}

function formatCurrency(amount) {
    return amount.toLocaleString('en-US') + ' ETB';
}

function mainMenu(userId) {
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const buttons = [
        [{ text: "🎮 Play Game", callback_data: 'play' }],
        [{ text: "💰 Balance", callback_data: 'balance' }, { text: "🏦 Deposit", callback_data: 'deposit' }],
        [{ text: "📤 Withdraw", callback_data: 'withdraw' }, { text: "🔄 Transfer", callback_data: 'transfer' }],
        [{ text: "🎁 Bonus / Invite", callback_data: 'bonus' }, { text: "📜 History", callback_data: 'history' }],
        [{ text: "📖 Help", callback_data: 'help' }, { text: "📞 Support", callback_data: 'support' }],
        [{ text: "👤 Profile", callback_data: 'profile' }]
    ];
    if (isAdmin) buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    return { reply_markup: { inline_keyboard: buttons } };
}

// ============================================================
// START & REGISTRATION
// ============================================================
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;
    const referralId = match ? parseInt(match[1]) : null;

    // Check if already registered
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            const balance = await getUserBalance(userId);
            const welcomeBack = `👋 *Welcome back, ${firstName}!*\n\n💰 *Balance:* ${formatCurrency(balance)}\n👇 *Select an option:*`;
            await bot.sendMessage(chatId, welcomeBack, { parse_mode: 'Markdown', ...mainMenu(userId) });
            return;
        }
    } catch (error) { console.log('New user registration flow'); }

    const registerKeyboard = {
        reply_markup: {
            keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
            resize_keyboard: true, one_time_keyboard: true
        }
    };
    await bot.sendMessage(chatId, `📝 *Welcome to M-BINGO, ${firstName}!*\n\nPlease share your contact to register.`, { parse_mode: 'Markdown', ...registerKeyboard });
    bot._referralMap = bot._referralMap || {};
    bot._referralMap[userId] = referralId;
});

bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const contact = msg.contact;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;

    if (!contact || contact.user_id != userId) return bot.sendMessage(chatId, '❌ Please share your own contact.');

    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            await bot.sendMessage(chatId, '✅ You are already registered!');
            await bot.sendMessage(chatId, '🎯 *Welcome back!*', { parse_mode: 'Markdown', ...mainMenu(userId) });
            return;
        }
    } catch (error) {}

    const referralId = bot._referralMap ? bot._referralMap[userId] : null;
    const user = await getOrCreateUser(userId, firstName, lastName, username, referralId);

    if (user) {
        if (referralId) {
            try {
                await axios.post(`${API_URL}/api/referral/process`, { referrerId: referralId, newUserId: userId });
                await bot.sendMessage(referralId, `🎉 You earned ${REFERRAL_BONUS} Birr bonus!`);
            } catch (e) {}
        }
        await bot.sendMessage(chatId, '✅ Registration complete!', { reply_markup: { remove_keyboard: true } });
        const welcome = `✅ *Registration Successful!*\n\n🎯 Welcome to M-BINGO, ${firstName}!\n💰 You have received a *50 Birr* starting balance.\n\n👇 *Select an option:*`;
        await bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown', ...mainMenu(userId) });
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆕 New User: ${firstName} (${userId})`);
    } else {
        await bot.sendMessage(chatId, '✅ You are already registered!');
        await bot.sendMessage(chatId, '🎯 *Welcome back!*', { parse_mode: 'Markdown', ...mainMenu(userId) });
    }
});

// ============================================================
// DEPOSIT FLOW (Amount -> Method -> Txn ID)
// ============================================================
bot.onText(/\/deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try { await axios.get(`${API_URL}/api/users/${userId}`); } catch (e) { return bot.sendMessage(chatId, '❌ Please register first using /start.'); }

    userState[chatId] = { step: 'DEPOSIT_AMOUNT', userId };
    await bot.sendMessage(chatId, '🏦 *Make a Deposit*\n\nPlease enter the amount (min 50 ETB):', { parse_mode: 'Markdown' });
});

// ============================================================
// WITHDRAW FLOW (Amount -> Method -> Account)
// ============================================================
bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try { await axios.get(`${API_URL}/api/users/${userId}`); } catch (e) { return bot.sendMessage(chatId, '❌ Please register first using /start.'); }

    userState[chatId] = { step: 'WITHDRAW_AMOUNT', userId };
    await bot.sendMessage(chatId, '📤 *Withdrawal*\n\nPlease enter the amount you wish to withdraw:', { parse_mode: 'Markdown' });
});

// ============================================================
// TRANSFER FLOW (Phone -> Amount)
// ============================================================
bot.onText(/\/transfer/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try { await axios.get(`${API_URL}/api/users/${userId}`); } catch (e) { return bot.sendMessage(chatId, '❌ Please register first using /start.'); }

    userState[chatId] = { step: 'TRANSFER_PHONE', userId };
    await bot.sendMessage(chatId, '🔄 *Transfer Funds*\n\nPlease enter the recipient\'s Telegram ID:', { parse_mode: 'Markdown' });
});

// ============================================================
// BALANCE & PROFILE COMMANDS
// ============================================================
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const balance = await getUserBalance(userId);
    await bot.sendMessage(chatId, `💰 *Your Balance*\n\n${formatCurrency(balance)}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        const user = response.data.user;
        await bot.sendMessage(chatId, `👤 *Profile*\n\n📛 Name: ${user.first_name}\n🆔 ID: ${user.telegramId}\n💰 Balance: ${user.balance} ETB\n🏆 Wins: ${user.wins || 0}`, { parse_mode: 'Markdown' });
    } catch (e) { await bot.sendMessage(chatId, '⚠️ Could not fetch profile.'); }
});

// ============================================================
// INVITE & SUPPORT
// ============================================================
bot.onText(/\/bonus/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;
    await bot.sendMessage(chatId, `🎁 *Invite Friends & Earn!*\n\nShare your link:\n${inviteLink}\n\nEarn *${REFERRAL_BONUS} Birr* per friend!`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "📤 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}` }]] }
    });
});

bot.onText(/\/support/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '📞 *Support*\n\n👤 @frezerabiy\n📧 support@mbingo.com', { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `📖 *Commands*\n\n/start - Start & Register\n/play - Play\n/balance - Check balance\n/deposit - Deposit\n/withdraw - Withdraw\n/transfer - Transfer\n/bonus - Invite\n/support - Support`, { parse_mode: 'Markdown' });
});

// ============================================================
// MAIN CALLBACK HANDLER
// ============================================================
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    // Play -> Stake Selection -> Open Mini App
    if (data.startsWith('stake_')) {
        const stake = parseInt(data.split('_')[1]);
        const gameUrl = `${GAME_URL}?stake=${stake}&userId=${userId}`;
        await bot.sendMessage(chatId, `✅ Stake set to ${stake} Birr.\n\n🎮 Click below to select your cards:`, {
            reply_markup: { inline_keyboard: [[{ text: "🎮 Open Game", web_app: { url: gameUrl } }]] }
        });
        return;
    }

    switch (data) {
        case 'play':
            await bot.sendMessage(chatId, '🎯 *Select your stake amount:*', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "10 Birr", callback_data: 'stake_10' }, { text: "20 Birr", callback_data: 'stake_20' }],
                        [{ text: "30 Birr", callback_data: 'stake_30' }, { text: "50 Birr", callback_data: 'stake_50' }],
                        [{ text: "100 Birr", callback_data: 'stake_100' }, { text: "❌ Cancel", callback_data: 'cancel' }]
                    ]
                }
            });
            break;
        case 'balance': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance'); break;
        case 'deposit': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/deposit'); break;
        case 'withdraw': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/withdraw'); break;
        case 'transfer': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/transfer'); break;
        case 'bonus': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/bonus'); break;
        case 'history': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/history'); break;
        case 'help': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/help'); break;
        case 'support': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/support'); break;
        case 'profile': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/profile'); break;
        case 'cancel': await bot.sendMessage(chatId, '❌ Action cancelled.'); break;
        
        // Admin Login Gate
        case 'admin_panel':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
            adminLoginState[chatId] = { step: 'USERNAME' };
            await bot.sendMessage(chatId, '🔐 *Enter Admin Username:*', { parse_mode: 'Markdown' });
            break;
    }
});

// ============================================================
// ADMIN COMMANDS (ADD/SUBTRACT/BROADCAST)
// ============================================================
bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    try {
        await axios.post(`${API_URL}/api/admin/balance/add`, { userId: targetId, amount, adminId: userId });
        await bot.sendMessage(chatId, `✅ Added ${amount} Birr to player!`);
    } catch (e) { await bot.sendMessage(chatId, '⚠️ Error adding balance.'); }
});

// ============================================================
// TEXT MESSAGE HANDLER FOR FLOWS & ADMIN LOGIN
// ============================================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    // Handle Admin Login State
    if (adminLoginState[chatId]) {
        const state = adminLoginState[chatId];
        if (state.step === 'USERNAME') {
            if (text !== ADMIN_USERNAME) { delete adminLoginState[chatId]; return bot.sendMessage(chatId, '❌ Invalid Username.'); }
            adminLoginState[chatId] = { step: 'PASSWORD' };
            return bot.sendMessage(chatId, '🔐 *Enter Admin Password:*', { parse_mode: 'Markdown' });
        }
        if (state.step === 'PASSWORD') {
            delete adminLoginState[chatId];
            let isPasswordValid = false;
            if (ADMIN_PASSWORD_HASH) {
                isPasswordValid = await bcrypt.compare(text, ADMIN_PASSWORD_HASH);
            } else if (text === 'admin123') {
                isPasswordValid = true;
            }
            if (!isPasswordValid) return bot.sendMessage(chatId, '❌ Invalid Password.');

            // Success! Show Admin Options
            await bot.sendMessage(chatId, '👑 *Admin Panel*', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 Players', callback_data: 'admin_players' }],
                        [{ text: '📥 Deposit Requests', callback_data: 'admin_deposits' }],
                        [{ text: '📤 Withdraw Requests', callback_data: 'admin_withdrawals' }],
                        [{ text: '📊 Stats', callback_data: 'admin_stats' }],
                        [{ text: '🔙 Back', callback_data: 'back_to_menu' }]
                    ]
                }
            });
        }
        return;
    }

    // Deposit Flow
    if (userState[chatId]?.step === 'DEPOSIT_AMOUNT') {
        const amount = parseInt(text);
        if (isNaN(amount) || amount < 50 || amount > 5000) return bot.sendMessage(chatId, '❌ Invalid amount. Enter between 50 and 5000.');
        userState[chatId] = { step: 'DEPOSIT_METHOD', amount };
        const methodKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏦 Bank Transfer", callback_data: `deposit_method_bank_${amount}` }],
                    [{ text: "💳 CBE Birr", callback_data: `deposit_method_cbe_${amount}` }]
                ]
            }
        };
        return bot.sendMessage(chatId, '💰 *Select method:*', { parse_mode: 'Markdown', ...methodKeyboard });
    }

    // Withdraw Flow
    if (userState[chatId]?.step === 'WITHDRAW_AMOUNT') {
        const amount = parseInt(text);
        const balance = await getUserBalance(userId);
        if (isNaN(amount) || amount <= 0 || amount > balance) return bot.sendMessage(chatId, `❌ Invalid or insufficient balance. You have ${formatCurrency(balance)}.`);
        userState[chatId] = { step: 'WITHDRAW_METHOD', amount };
        const methodKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏦 Bank Transfer", callback_data: `withdraw_method_bank_${amount}` }],
                    [{ text: "💳 CBE Birr", callback_data: `withdraw_method_cbe_${amount}` }]
                ]
            }
        };
        return bot.sendMessage(chatId, '📤 *Select method:*', { parse_mode: 'Markdown', ...methodKeyboard });
    }

    // Transfer Flow
    if (userState[chatId]?.step === 'TRANSFER_PHONE') {
        const recipient = text.trim();
        try {
            await axios.get(`${API_URL}/api/users/${recipient}`);
            userState[chatId] = { step: 'TRANSFER_AMOUNT', recipient };
            return bot.sendMessage(chatId, '💵 *Enter amount to transfer:*', { parse_mode: 'Markdown' });
        } catch (e) {
            return bot.sendMessage(chatId, '❌ User not found. Please try again.');
        }
    }
    if (userState[chatId]?.step === 'TRANSFER_AMOUNT') {
        const amount = parseInt(text);
        const balance = await getUserBalance(userId);
        if (isNaN(amount) || amount <= 0 || amount > balance) return bot.sendMessage(chatId, `❌ Invalid or insufficient balance.`);
        const recipient = userState[chatId].recipient;
        await axios.post(`${API_URL}/api/transfer`, { fromId: userId, toId: recipient, amount });
        await bot.sendMessage(chatId, `✅ Transferred ${formatCurrency(amount)} to user ${recipient}.`);
        await bot.sendMessage(recipient, `📥 You received ${formatCurrency(amount)} from a transfer!`);
        delete userState[chatId];
        return;
    }
});

// ============================================================
// DEPOSIT/WITHDRAW CALLBACK HANDLERS (METHODS & TXN)
// ============================================================
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    // Deposit Method Selected
    if (data.startsWith('deposit_method_')) {
        const parts = data.split('_');
        const method = parts[2];
        const amount = parseInt(parts[3]);
        const accountDetails = method === 'bank' ? "1000070045207" : "Frezer Abiy";
        const state = userState[chatId];
        
        userState[chatId] = { step: 'DEPOSIT_TXN', amount, method, userId };
        await bot.sendMessage(chatId, `📌 *Payment Details (${method.toUpperCase()}):*\n\nAccount: ${accountDetails}\nName: Frezer Abiy\nAmount: ${formatCurrency(amount)}\n\nPlease send money and then paste your *Transaction ID* here:`, { parse_mode: 'Markdown' });
        return;
    }

    // Withdraw Method Selected
    if (data.startsWith('withdraw_method_')) {
        const parts = data.split('_');
        const method = parts[2];
        const amount = parseInt(parts[3]);
        userState[chatId] = { step: 'WITHDRAW_ACCOUNT', amount, method, userId };
        await bot.sendMessage(chatId, `📤 Please enter your ${method.toUpperCase()} account number or phone number:`, { parse_mode: 'Markdown' });
        return;
    }
});

// Handle Txn ID & Withdrawal Account
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    // Deposit Txn ID
    if (userState[chatId]?.step === 'DEPOSIT_TXN') {
        const txnId = text.trim();
        const state = userState[chatId];
        await axios.post(`${API_URL}/api/deposit/request`, { userId, amount: state.amount, method: state.method, txnId });
        await bot.sendMessage(chatId, `✅ Deposit request submitted! Waiting for admin confirmation.`);
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `💳 Deposit: ${state.amount} ETB from ${userId} (Txn: ${txnId})`);
        delete userState[chatId];
        return;
    }

    // Withdraw Account Number
    if (userState[chatId]?.step === 'WITHDRAW_ACCOUNT') {
        const account = text.trim();
        const state = userState[chatId];
        await axios.post(`${API_URL}/api/withdraw/request`, { userId, amount: state.amount, method: state.method, account });
        await bot.sendMessage(chatId, `✅ Withdrawal request submitted! Waiting for admin confirmation.`);
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `📤 Withdrawal: ${state.amount} ETB from ${userId} (Account: ${account})`);
        delete userState[chatId];
        return;
    }

    // Ignore other text unless it's a command
});

// ============================================================
// ADMIN PANEL CALLBACK ACTIONS
// ============================================================
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    if (data === 'admin_players') {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
        try {
            const response = await axios.get(`${API_URL}/api/admin/players`);
            const players = response.data;
            let msg = '👥 *Players List*\n\n';
            players.slice(0, 20).forEach((p, i) => msg += `${i+1}. ${p.first_name} - 💰 ${p.balance} ETB\n`);
            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching players.'); }
        return;
    }

    if (data === 'admin_deposits' || data === 'admin_withdrawals') {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
        const isDeposit = data === 'admin_deposits';
        const url = isDeposit ? `${API_URL}/api/admin/deposits` : `${API_URL}/api/admin/withdrawals`;
        try {
            const response = await axios.get(url);
            const items = response.data;
            if (!items || items.length === 0) return bot.sendMessage(chatId, 'No pending items.');
            let msg = isDeposit ? '📥 *Pending Deposits*\n\n' : '📤 *Pending Withdrawals*\n\n';
            items.forEach((item) => {
                msg += `👤 ${item.userName} (${item.userId})\n💰 ${formatCurrency(item.amount)}\n🆔 ${item.txnId || item.account}\n\n`;
            });
            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching items.'); }
        return;
    }

    if (data === 'admin_stats') {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
        try {
            const response = await axios.get(`${API_URL}/api/admin/stats`);
            const s = response.data;
            await bot.sendMessage(chatId, `📊 *Stats*\n\n👥 Players: ${s.totalPlayers}\n🎮 Active Games: ${s.activeGames}`, { parse_mode: 'Markdown' });
        } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching stats.'); }
        return;
    }

    if (data === 'back_to_menu') {
        await bot.sendMessage(chatId, '🎯 *Welcome back!*', { parse_mode: 'Markdown', ...mainMenu(userId) });
        return;
    }
});

// ============================================================
// NOTIFICATION POLLER (For Admin Approvals)
// ============================================================
setInterval(async () => {
    try {
        const deposits = await pool.query(
            `SELECT d.*, u.telegram_id FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status IN ('APPROVED', 'REJECTED') AND d.notified = FALSE`
        );
        for (let d of deposits.rows) {
            const msg = d.status === 'APPROVED' ? `💰 Deposit Successful! ${d.amount} Birr added.` : `❌ Deposit Rejected. Please try again.`;
            await bot.sendMessage(d.telegram_id, msg, { parse_mode: 'Markdown' });
            await pool.query('UPDATE deposits SET notified = TRUE WHERE id = $1', [d.id]);
        }

        const withdrawals = await pool.query(
            `SELECT w.*, u.telegram_id FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status IN ('APPROVED', 'REJECTED') AND w.notified = FALSE`
        );
        for (let w of withdrawals.rows) {
            const msg = w.status === 'APPROVED' ? `🏦 Withdrawal Successful! ${w.amount} Birr sent.` : `❌ Withdrawal Rejected. Please try again.`;
            await bot.sendMessage(w.telegram_id, msg, { parse_mode: 'Markdown' });
            await pool.query('UPDATE withdrawals SET notified = TRUE WHERE id = $1', [w.id]);
        }
    } catch (e) {
        console.error('Notification Poller Error:', e.message);
    }
}, 10000);

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
