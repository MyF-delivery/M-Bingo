// ============================================================
// M-BINGO TELEGRAM BOT - FULL FEATURED
// File: bot/bot.js
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

console.log('🤖 M-BINGO Bot Configuration:');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎮 Game URL: ${GAME_URL}`);
console.log(`👑 Admin ID: ${ADMIN_TELEGRAM_ID}`);
console.log(`🌐 Port: ${PORT}`);

// ============================================================
// DATABASE CONNECTION (PostgreSQL)
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
    try {
        await pool.query('SELECT NOW()');
        res.json({ status: 'ok', database: 'connected' });
    } catch (e) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

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

app.get('/api/admin/data', async (req, res) => {
    if (req.query.adminId !== ADMIN_TELEGRAM_ID) return res.status(401).json({ success: false });
    try {
        const response = await axios.get(`${API_URL}/api/admin/players`);
        res.json({ success: true, players: response.data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error fetching players' });
    }
});

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
        });
        return response.data.user;
    } catch (error) {
        console.error('Registration error:', error.message);
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

// ============================================================
// MAIN MENU (Matches Python example)
// ============================================================

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

// ============================================================
// COMMAND HANDLERS
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
            const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
            const welcomeBack = `👋 *Welcome back, ${firstName}!*${isAdmin ? ' 👑' : ''}\n\n` +
                `💰 *Balance:* ${formatCurrency(balance)}\n` +
                `📊 *Games Played:* ${response.data.user.gamesPlayed || 0}\n` +
                `🏆 *Wins:* ${response.data.user.wins || 0}\n\n` +
                `👇 *Select an option below:*`;
            await bot.sendMessage(chatId, welcomeBack, {
                parse_mode: 'Markdown',
                ...mainMenu(userId)
            });
            return;
        }
    } catch (error) {
        // Not found – register
        console.log('New user registration flow');
    }

    // New user: ask to share contact
    const registerMessage = `
📝 *Welcome to M-BINGO, ${firstName}!*

To complete your registration, please share your contact by clicking the button below.

🔒 *Your Telegram ID will be used to securely identify you.*
    `;
    const registerKeyboard = {
        reply_markup: {
            keyboard: [
                [{ text: "📱 Share Contact", request_contact: true }]
            ],
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

    // Check again if already registered
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            await bot.sendMessage(chatId, '✅ You are already registered!');
            return;
        }
    } catch (error) {}

    const referralId = bot._referralMap ? bot._referralMap[userId] : null;

    try {
        const user = await getOrCreateUser(userId, firstName, lastName, username, referralId);
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
                `💰 You have received a *${formatCurrency(0)}* starting balance.\n\n` +
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
        }
    } catch (error) {
        console.error('Registration error:', error);
        await bot.sendMessage(chatId, '❌ Registration failed. Please try again later.');
    }
});

// ---- All slash commands ----
bot.onText(/\/play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        await axios.get(`${API_URL}/api/users/${userId}`);
    } catch (e) {
        await bot.sendMessage(chatId, '❌ Please register first using /start.');
        return;
    }
    const stakeOptions = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "10 Birr", callback_data: 'stake_10' }, { text: "20 Birr", callback_data: 'stake_20' }],
                [{ text: "30 Birr", callback_data: 'stake_30' }, { text: "50 Birr", callback_data: 'stake_50' }],
                [{ text: "100 Birr", callback_data: 'stake_100' }, { text: "200 Birr", callback_data: 'stake_200' }],
                [{ text: "❌ Cancel", callback_data: 'cancel' }]
            ]
        }
    };
    await bot.sendMessage(chatId, '🎯 *Select your stake amount:*\n\nChoose how much you want to bet per card.\nYou can select up to 5 cards per game.', {
        parse_mode: 'Markdown',
        ...stakeOptions
    });
});

bot.onText(/\/register/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            await bot.sendMessage(chatId, `✅ You are already registered as ${response.data.user.first_name}.`);
            return;
        }
    } catch (e) {}
    const registerMessage = `📝 *To register, please share your contact.*\n\nClick the button below to share your Telegram contact.`;
    const registerKeyboard = {
        reply_markup: {
            keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    };
    await bot.sendMessage(chatId, registerMessage, { parse_mode: 'Markdown', ...registerKeyboard });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `
📖 *M-BINGO Help*

*Commands:*
/start - Start bot and register
/play - Start a game (select stake)
/balance - Check your balance
/deposit - Make a deposit
/withdraw - Withdraw funds
/transfer - Transfer funds to another user
/bonus - Invite friends and earn bonus
/history - View your transaction and game history
/profile - View your profile
/help - Show this help

*How to Play:*
1. Tap "Play Game" or use /play
2. Choose your stake
3. Select 1-5 BINGO cards in the web app
4. Wait for 2+ players to join
5. Game starts automatically
6. First to complete a pattern wins 70% of the pool!

*Support:* @frezerabiy
    `, { parse_mode: 'Markdown' });
});

bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const balance = await getUserBalance(userId);
    await bot.sendMessage(chatId, `💰 *Your Balance*\n\n${formatCurrency(balance)}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await bot.sendMessage(chatId, '🏦 *Make a Deposit*\n\nPlease enter the amount you wish to deposit (minimum 50 ETB).', { parse_mode: 'Markdown' });
    bot.once('text', async (msg) => {
        const amount = parseInt(msg.text);
        if (isNaN(amount) || amount < 50 || amount > 5000) {
            await bot.sendMessage(chatId, '❌ Invalid amount. Please enter a number between 50 and 5000.');
            return;
        }
        const methodKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏦 CBE Birr", callback_data: `deposit_method_cbe_${amount}` }],
                    [{ text: "📱 Telebirr", callback_data: `deposit_method_telebirr_${amount}` }],
                    [{ text: "❌ Cancel", callback_data: 'cancel' }]
                ]
            }
        };
        await bot.sendMessage(chatId, '💰 *Select payment method:*', { parse_mode: 'Markdown', ...methodKeyboard });
    });
});

bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await bot.sendMessage(chatId, '📤 *Withdrawal*\n\nPlease enter the amount you wish to withdraw.', { parse_mode: 'Markdown' });
    bot.once('text', async (msg) => {
        const amount = parseInt(msg.text);
        if (isNaN(amount) || amount <= 0) {
            await bot.sendMessage(chatId, '❌ Invalid amount.');
            return;
        }
        const balance = await getUserBalance(userId);
        if (amount > balance) {
            await bot.sendMessage(chatId, `❌ Insufficient balance. Your balance is ${formatCurrency(balance)}.`);
            return;
        }
        const methodKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏦 CBE Birr", callback_data: `withdraw_method_cbe_${amount}` }],
                    [{ text: "📱 Telebirr", callback_data: `withdraw_method_telebirr_${amount}` }],
                    [{ text: "❌ Cancel", callback_data: 'cancel' }]
                ]
            }
        };
        await bot.sendMessage(chatId, '📤 *Select withdrawal method:*', { parse_mode: 'Markdown', ...methodKeyboard });
    });
});

bot.onText(/\/transfer/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await bot.sendMessage(chatId, '🔄 *Transfer Funds*\n\nPlease enter the recipient\'s Telegram ID or username.', { parse_mode: 'Markdown' });
    bot.once('text', async (msg) => {
        const recipientInput = msg.text.trim();
        let recipientId;
        if (recipientInput.startsWith('@')) {
            try {
                const response = await axios.get(`${API_URL}/api/users/by-username/${recipientInput.substring(1)}`);
                recipientId = response.data.user.telegramId;
            } catch (e) {
                await bot.sendMessage(chatId, '❌ User not found. Please make sure they are registered.');
                return;
            }
        } else {
            recipientId = parseInt(recipientInput);
            if (isNaN(recipientId)) {
                await bot.sendMessage(chatId, '❌ Invalid input. Please enter a valid Telegram ID or @username.');
                return;
            }
        }
        try {
            await axios.get(`${API_URL}/api/users/${recipientId}`);
        } catch (e) {
            await bot.sendMessage(chatId, `❌ User with ID ${recipientId} is not registered.\n\n📩 *Invite them to join M-BINGO!*\nShare this link: https://t.me/M_bingo_bot?start=ref_${userId}`);
            return;
        }
        await bot.sendMessage(chatId, '💵 *Enter amount to transfer:*', { parse_mode: 'Markdown' });
        bot.once('text', async (msg2) => {
            const amount = parseInt(msg2.text);
            if (isNaN(amount) || amount <= 0) {
                await bot.sendMessage(chatId, '❌ Invalid amount.');
                return;
            }
            const balance = await getUserBalance(userId);
            if (amount > balance) {
                await bot.sendMessage(chatId, `❌ Insufficient balance. Your balance is ${formatCurrency(balance)}.`);
                return;
            }
            try {
                await axios.post(`${API_URL}/api/transfer`, { fromId: userId, toId: recipientId, amount });
                await bot.sendMessage(chatId, `✅ Successfully transferred ${formatCurrency(amount)} to user ${recipientId}.`);
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Transfer failed. Please try again later.');
            }
        });
    });
});

bot.onText(/\/bonus/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const inviteLink = `https://t.me/M_bingo_bot?start=ref_${userId}`;
    const inviteMsg = `
🎁 *Invite Friends & Earn!*

Share your unique referral link with friends:

${inviteLink}

For each friend who registers using your link, you earn *${REFERRAL_BONUS} Birr* bonus!

🎁 *Bonus credited instantly upon their registration!*
    `;
    await bot.sendMessage(chatId, inviteMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "📤 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}` }],
                [{ text: "📋 Copy Link", callback_data: 'copy_invite' }]
            ]
        }
    });
});

bot.onText(/\/history/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const response = await axios.get(`${API_URL}/api/transactions/${userId}`);
        const txs = response.data.transactions || [];
        if (txs.length === 0) {
            await bot.sendMessage(chatId, '📜 No transactions found.');
            return;
        }
        let msgText = '📜 *Your Transaction History*\n\n';
        txs.slice(0, 10).forEach(t => {
            const type = t.type === 'deposit' ? '💰 Deposit' :
                        t.type === 'withdraw' ? '📤 Withdraw' :
                        t.type === 'transfer' ? '🔄 Transfer' : '🎮 Game';
            const sign = t.type === 'deposit' ? '+' : '-';
            msgText += `${type}: ${sign}${formatCurrency(t.amount)} - ${t.status}\n`;
        });
        await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    } catch (e) {
        await bot.sendMessage(chatId, '⚠️ Could not fetch transactions.');
    }
});

bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        const user = response.data.user;
        const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
        const adminBadge = isAdmin ? ' 👑 (Admin)' : '';
        const message = `
👤 *Your Profile*${adminBadge}

📛 *Name:* ${user.first_name || 'Player'}
🆔 *ID:* ${user.telegramId}
💰 *Balance:* ${user.balance || 0} Birr
🎴 *Cards:* ${user.cards?.length || 0}
🏆 *Games Played:* ${user.gamesPlayed || 0}
🎖️ *Wins:* ${user.wins || 0}
📅 *Joined:* ${new Date(user.createdAt).toLocaleDateString()}
        `;
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (e) {
        await bot.sendMessage(chatId, '⚠️ Could not fetch profile.');
    }
});

// ============================================================
// CALLBACK QUERY HANDLER
// ============================================================

bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    // Stake selection
    if (data.startsWith('stake_')) {
        const stake = parseInt(data.split('_')[1]);
        const gameUrl = `${GAME_URL}?stake=${stake}&userId=${userId}`;
        await bot.sendMessage(chatId, `✅ Stake set to ${stake} Birr.\n\n🎮 Click below to open the game and select your cards:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🎮 Open Game", web_app: { url: gameUrl } }],
                    [{ text: "🔙 Back to Menu", callback_data: 'back_to_menu' }]
                ]
            }
        });
        return;
    }

    // Main menu actions
    switch (data) {
        case 'play': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/play'); break;
        case 'balance': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance'); break;
        case 'deposit': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/deposit'); break;
        case 'withdraw': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/withdraw'); break;
        case 'transfer': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/transfer'); break;
        case 'bonus': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/bonus'); break;
        case 'history': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/history'); break;
        case 'help': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/help'); break;
        case 'profile': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/profile'); break;
        case 'support':
            await bot.sendMessage(chatId, '📞 *Contact Support*\n\n👤 @frezerabiy\n📧 support@mbingo.com', { parse_mode: 'Markdown' });
            break;
        case 'patterns':
            await bot.sendMessage(chatId, `
🏆 *Winning Patterns*

✅ Row - 5 numbers in a horizontal line
✅ Column - 5 numbers in a vertical line
✅ Diagonal - 5 numbers diagonally
✅ Corners - All 4 corners
✅ Full House - All numbers on card
            `, { parse_mode: 'Markdown' });
            break;
        case 'copy_invite': {
            const link = `https://t.me/M_bingo_bot?start=ref_${userId}`;
            await bot.sendMessage(chatId, `📋 *Your Invite Link:*\n\n${link}`, { parse_mode: 'Markdown' });
            break;
        }
        case 'back_to_menu':
            await bot.sendMessage(chatId, '🎯 *Welcome back!*', { parse_mode: 'Markdown', ...mainMenu(userId) });
            break;
        case 'cancel':
            await bot.sendMessage(chatId, '❌ Action cancelled.');
            break;
        // Deposit method
        default:
            if (data.startsWith('deposit_method_')) {
                const parts = data.split('_');
                const method = parts[2];
                const amount = parseInt(parts[3]);
                await bot.sendMessage(chatId, `✅ You selected ${method.toUpperCase()}.\n\n📌 *Payment Details:*\n🏦 Account: 1000070045207\n👤 Name: Frezer Abiy\n📱 Reference: ${method === 'cbe' ? 'CBE' : 'Telebirr'}\n\n💰 Amount: ${formatCurrency(amount)}\n\nPlease send the exact amount and then enter your *Transaction ID* (confirmation number).`);
                bot.once('text', async (msg) => {
                    const txnId = msg.text.trim();
                    if (!txnId || txnId.length < 5) {
                        await bot.sendMessage(chatId, '❌ Invalid Transaction ID. Please try again with /deposit.');
                        return;
                    }
                    await axios.post(`${API_URL}/api/deposit/request`, { userId, amount, method, txnId, status: 'pending' });
                    await bot.sendMessage(chatId, `✅ Deposit request submitted!\n\n💰 Amount: ${formatCurrency(amount)}\n📱 Method: ${method.toUpperCase()}\n🆔 Txn ID: ${txnId}\n\n⏳ Waiting for admin confirmation.`);
                    await bot.sendMessage(ADMIN_TELEGRAM_ID, `💳 *New Deposit Request*\n\n👤 User: ${msg.from.first_name} (${userId})\n💰 Amount: ${formatCurrency(amount)}\n📱 Method: ${method.toUpperCase()}\n🆔 Txn ID: ${txnId}`);
                });
                return;
            }
            if (data.startsWith('withdraw_method_')) {
                const parts = data.split('_');
                const method = parts[2];
                const amount = parseInt(parts[3]);
                await bot.sendMessage(chatId, `✅ You selected ${method.toUpperCase()}.\n\n📤 *Withdrawal Request*\n💰 Amount: ${formatCurrency(amount)}\n📱 Method: ${method.toUpperCase()}\n\nPlease enter your ${method.toUpperCase()} account number or phone number:`);
                bot.once('text', async (msg) => {
                    const account = msg.text.trim();
                    if (!account) {
                        await bot.sendMessage(chatId, '❌ Invalid account details. Please try again with /withdraw.');
                        return;
                    }
                    await axios.post(`${API_URL}/api/withdraw/request`, { userId, amount, method, account, status: 'pending' });
                    await bot.sendMessage(chatId, `✅ Withdrawal request submitted!\n\n💰 Amount: ${formatCurrency(amount)}\n📱 Method: ${method.toUpperCase()}\n🏦 Account: ${account}\n\n⏳ Waiting for admin approval.`);
                    await bot.sendMessage(ADMIN_TELEGRAM_ID, `📤 *New Withdrawal Request*\n\n👤 User: ${msg.from.first_name} (${userId})\n💰 Amount: ${formatCurrency(amount)}\n📱 Method: ${method.toUpperCase()}\n🏦 Account: ${account}`);
                });
                return;
            }
            // Admin panel
            if (data === 'admin_panel') {
                if (userId.toString() !== ADMIN_TELEGRAM_ID) { await bot.sendMessage(chatId, '⛔ Unauthorized.'); break; }
                await bot.sendMessage(chatId, '👑 *Admin Panel*', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '👥 Players', callback_data: 'admin_players' }],
                            [{ text: '📊 Stats', callback_data: 'admin_stats' }],
                            [{ text: '💰 Add Balance', callback_data: 'admin_add_balance' }],
                            [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
                            [{ text: '📥 Deposit Requests', callback_data: 'admin_deposits' }],
                            [{ text: '📤 Withdraw Requests', callback_data: 'admin_withdrawals' }],
                            [{ text: '🔙 Back', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
                break;
            }
            if (data === 'admin_players') {
                if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
                try {
                    const response = await axios.get(`${API_URL}/api/admin/players`);
                    const players = response.data;
                    let msg = '👥 *Players List*\n\n';
                    players.slice(0, 20).forEach((p, i) => msg += `${i+1}. ${p.first_name || 'Player'} - 💰 ${p.balance || 0} Birr\n`);
                    msg += `\n📊 Total: ${players.length}`;
                    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
                } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching players.'); }
                break;
            }
            if (data === 'admin_stats') {
                if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
                try {
                    const response = await axios.get(`${API_URL}/api/admin/stats`);
                    const s = response.data;
                    await bot.sendMessage(chatId, `📊 *Server Stats*\n\n👥 Online: ${s.onlinePlayers || 0}\n🎮 Active Games: ${s.activeGames || 0}\n💰 Revenue Today: ${s.todayRevenue || 0} Birr\n📈 Total Users: ${s.totalPlayers || 0}`, { parse_mode: 'Markdown' });
                } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching stats.'); }
                break;
            }
            if (data === 'admin_add_balance') {
                if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
                await bot.sendMessage(chatId, '💰 *Add Balance*\n\nUse: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 123456789 100');
                break;
            }
            if (data === 'admin_broadcast') {
                if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
                await bot.sendMessage(chatId, '📢 *Send Broadcast*\n\nUse: /broadcast [your message]');
                break;
            }
            if (data === 'admin_deposits') {
                if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
                try {
                    const response = await axios.get(`${API_URL}/api/admin/deposits`);
                    const deposits = response.data;
                    if (!deposits || deposits.length === 0) { await bot.sendMessage(chatId, 'No pending deposits.'); break; }
                    let msg = '📥 *Pending Deposits*\n\n';
                    deposits.forEach(d => msg += `👤 ${d.userName} (${d.userId})\n💰 ${formatCurrency(d.amount)}\n📱 ${d.method}\n🆔 ${d.txnId}\n\n`);
                    await bot.sendMessage(chatId, msg);
                } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching deposits.'); }
                break;
            }
            if (data === 'admin_withdrawals') {
                if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
                try {
                    const response = await axios.get(`${API_URL}/api/admin/withdrawals`);
                    const withdrawals = response.data;
                    if (!withdrawals || withdrawals.length === 0) { await bot.sendMessage(chatId, 'No pending withdrawals.'); break; }
                    let msg = '📤 *Pending Withdrawals*\n\n';
                    withdrawals.forEach(w => msg += `👤 ${w.userName} (${w.userId})\n💰 ${formatCurrency(w.amount)}\n📱 ${w.method}\n🏦 ${w.account}\n\n`);
                    await bot.sendMessage(chatId, msg);
                } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching withdrawals.'); }
                break;
            }
            break;
    }
});

// ============================================================
// ADMIN COMMANDS
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

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    await bot.sendMessage(chatId, `📢 Broadcast sent: "${match[1]}"`);
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
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`📡 API URL: ${API_URL}`);
console.log(`👑 Admin ID: ${ADMIN_TELEGRAM_ID}`);
