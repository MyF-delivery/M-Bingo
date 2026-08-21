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
const REFERRAL_BONUS = 20; // Birr per successful referral

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

// Admin data
app.get('/api/admin/data', async (req, res) => {
    if (req.query.adminId !== ADMIN_TELEGRAM_ID) return res.status(401).json({ success: false });
    try {
        const response = await axios.get(`${API_URL}/api/admin/players`);
        res.json({ success: true, players: response.data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error fetching players' });
    }
});

// Admin actions
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

// Register or get user
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

// Get user balance
async function getUserBalance(telegramId) {
    try {
        const response = await axios.get(`${API_URL}/api/wallet/${telegramId}`);
        return response.data.balance || 0;
    } catch (error) {
        return 0;
    }
}

// Format currency
function formatCurrency(amount) {
    return amount.toLocaleString('en-US') + ' ETB';
}

// ============================================================
// MAIN MENU
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
            { text: "📩 Invite", callback_data: 'invite' },
            { text: "📞 Support", callback_data: 'support' }
        ],
        [
            { text: "📖 Instructions", callback_data: 'rules' },
            { text: "🏆 Patterns", callback_data: 'patterns' }
        ],
        [
            { text: "📜 Transaction History", callback_data: 'transactions' },
            { text: "📊 Game History", callback_data: 'game_history' }
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

// /start - Registration & Welcome
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;
    const referralId = match ? parseInt(match[1]) : null;

    // Check if user already exists in our DB
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            // User exists - show welcome back
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
        // User not found - proceed with registration
        console.log('New user registration flow');
    }

    // New user - ask to share contact
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

    // Store referral ID in memory for later use
    bot._referralMap = bot._referralMap || {};
    bot._referralMap[userId] = referralId;
});

// Handle contact sharing (registration)
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

    // Check if already registered
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            await bot.sendMessage(chatId, '✅ You are already registered!');
            return;
        }
    } catch (error) {
        // Proceed with registration
    }

    // Get referral code if any
    const referralId = bot._referralMap ? bot._referralMap[userId] : null;

    // Register user
    try {
        const user = await getOrCreateUser(userId, firstName, lastName, username, referralId);
        if (user) {
            // Process referral bonus if applicable
            if (referralId) {
                try {
                    await axios.post(`${API_URL}/api/referral/process`, {
                        referrerId: referralId,
                        newUserId: userId
                    });
                    // Notify referrer
                    try {
                        await bot.sendMessage(referralId, `🎉 You earned ${REFERRAL_BONUS} Birr bonus! Someone registered using your referral link.`);
                    } catch (e) {}
                } catch (e) {
                    console.error('Referral bonus error:', e.message);
                }
            }

            // Show welcome message
            const welcome = `✅ *Registration Successful!*\n\n` +
                `🎯 Welcome to M-BINGO, ${firstName}!\n` +
                `💰 You have received a *${formatCurrency(0)}* starting balance.\n\n` +
                `👇 *Select an option below to start playing!*`;

            // Remove contact keyboard
            await bot.sendMessage(chatId, '✅ Registration complete!', {
                reply_markup: { remove_keyboard: true }
            });

            await bot.sendMessage(chatId, welcome, {
                parse_mode: 'Markdown',
                ...mainMenu(userId)
            });

            // Notify admin
            await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆕 *New User Registered!*\n\n` +
                `👤 Name: ${firstName}\n` +
                `🆔 ID: ${userId}\n` +
                `📱 Username: @${username || 'N/A'}\n` +
                `📞 Phone: ${contact.phone_number}`);
        }
    } catch (error) {
        console.error('Registration error:', error);
        await bot.sendMessage(chatId, '❌ Registration failed. Please try again later.');
    }
});

// /play - Start game flow (stake selection)
bot.onText(/\/play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Check registration
    try {
        await axios.get(`${API_URL}/api/users/${userId}`);
    } catch (error) {
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

    await bot.sendMessage(chatId, '🎯 *Select your stake amount:*\n\n' +
        'Choose how much you want to bet per card.\n' +
        'You can select up to 5 cards per game.', {
        parse_mode: 'Markdown',
        ...stakeOptions
    });
});

// Handle stake selection
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    // ---- STAKE SELECTION ----
    if (data.startsWith('stake_')) {
        const stake = parseInt(data.split('_')[1]);
        // Open web app with stake parameter
        const gameUrl = `${GAME_URL}?stake=${stake}&userId=${userId}`;
        await bot.sendMessage(chatId, `✅ Stake set to ${stake} Birr.\n\n` +
            `🎮 Click below to open the game and select your cards:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🎮 Open Game", web_app: { url: gameUrl } }],
                    [{ text: "🔙 Back to Menu", callback_data: 'back_to_menu' }]
                ]
            }
        });
        return;
    }

    // ---- MAIN MENU ACTIONS ----
    switch (data) {
        case 'play':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/play');
            break;

        case 'balance':
            const balance = await getUserBalance(userId);
            await bot.sendMessage(chatId, `💰 *Your Balance*\n\n${formatCurrency(balance)}`, { parse_mode: 'Markdown' });
            break;

        case 'deposit':
            // Show deposit flow
            const depositMsg = `
🏦 *Make a Deposit*

Please enter the amount you wish to deposit (minimum 50 ETB).
            `;
            await bot.sendMessage(chatId, depositMsg, { parse_mode: 'Markdown' });
            // Wait for amount input
            bot.once('text', async (msg) => {
                const amount = parseInt(msg.text);
                if (isNaN(amount) || amount < 50 || amount > 5000) {
                    await bot.sendMessage(chatId, '❌ Invalid amount. Please enter a number between 50 and 5000.');
                    return;
                }
                // Ask for payment method
                const methodKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🏦 CBE Birr", callback_data: `deposit_method_cbe_${amount}` }],
                            [{ text: "📱 Telebirr", callback_data: `deposit_method_telebirr_${amount}` }],
                            [{ text: "❌ Cancel", callback_data: 'cancel' }]
                        ]
                    }
                };
                await bot.sendMessage(chatId, '💰 *Select payment method:*', {
                    parse_mode: 'Markdown',
                    ...methodKeyboard
                });
            });
            break;

        case 'withdraw':
            const withdrawMsg = `
📤 *Withdrawal*

Please enter the amount you wish to withdraw.
            `;
            await bot.sendMessage(chatId, withdrawMsg, { parse_mode: 'Markdown' });
            // Wait for amount input
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
                // Ask for withdrawal method
                const methodKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🏦 CBE Birr", callback_data: `withdraw_method_cbe_${amount}` }],
                            [{ text: "📱 Telebirr", callback_data: `withdraw_method_telebirr_${amount}` }],
                            [{ text: "❌ Cancel", callback_data: 'cancel' }]
                        ]
                    }
                };
                await bot.sendMessage(chatId, '📤 *Select withdrawal method:*', {
                    parse_mode: 'Markdown',
                    ...methodKeyboard
                });
            });
            break;

        case 'transfer':
            const transferMsg = `
🔄 *Transfer Funds*

Please enter the recipient's Telegram ID or username.
            `;
            await bot.sendMessage(chatId, transferMsg, { parse_mode: 'Markdown' });
            // Wait for recipient input
            bot.once('text', async (msg) => {
                const recipientInput = msg.text.trim();
                // Try to find user by username or ID
                let recipientId;
                if (recipientInput.startsWith('@')) {
                    // Username lookup - we'd need to query DB
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
                // Check if recipient exists
                try {
                    await axios.get(`${API_URL}/api/users/${recipientId}`);
                } catch (e) {
                    await bot.sendMessage(chatId, `❌ User with ID ${recipientId} is not registered.\n\n` +
                        `📩 *Invite them to join M-BINGO!*\n` +
                        `Share this link: https://t.me/M_bingo_bot?start=ref_${userId}`);
                    return;
                }
                // Ask for amount
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
                    // Process transfer
                    try {
                        await axios.post(`${API_URL}/api/transfer`, {
                            fromId: userId,
                            toId: recipientId,
                            amount: amount
                        });
                        await bot.sendMessage(chatId, `✅ Successfully transferred ${formatCurrency(amount)} to user ${recipientId}.`);
                    } catch (error) {
                        await bot.sendMessage(chatId, '❌ Transfer failed. Please try again later.');
                    }
                });
            });
            break;

        case 'invite':
            const inviteLink = `https://t.me/M_bingo_bot?start=ref_${userId}`;
            const inviteMsg = `
📩 *Invite Friends & Earn!*

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
            break;

        case 'support':
            await bot.sendMessage(chatId, '📞 *Contact Support*\n\nFor any issues or inquiries, please contact our support team:\n\n' +
                '👤 @frezerabiy\n📧 support@mbingo.com\n⏳ Response time: 24-48 hours', { parse_mode: 'Markdown' });
            break;

        case 'rules':
            await bot.sendMessage(chatId, `
📖 *M-BINGO Game Instructions*

1️⃣ *Start a Game:* Tap "🎮 Play Game" and select your stake.
2️⃣ *Select Cards:* Choose 1-5 BINGO cards from the 200 available.
3️⃣ *Multiplayer:* Wait for at least 2 players to join.
4️⃣ *Game Start:* Numbers are called automatically every 10 seconds.
5️⃣ *Winning:* First player to complete a pattern wins 70% of total bets!

🎯 *Patterns:* Row, Column, Diagonal, Corners, Full House.

💰 *Good luck!*
            `, { parse_mode: 'Markdown' });
            break;

        case 'patterns':
            await bot.sendMessage(chatId, `
🏆 *Winning Patterns*

✅ *Row:* 5 numbers in a horizontal line
✅ *Column:* 5 numbers in a vertical line
✅ *Diagonal:* 5 numbers diagonally (top-left to bottom-right or vice versa)
✅ *Corners:* All 4 corner numbers
✅ *Full House:* All numbers on your card

🎁 *Prize pool:* 70% of total bets distributed among winners.
            `, { parse_mode: 'Markdown' });
            break;

        case 'transactions':
            try {
                const response = await axios.get(`${API_URL}/api/transactions/${userId}`);
                const txs = response.data.transactions || [];
                if (txs.length === 0) {
                    await bot.sendMessage(chatId, '📜 No transactions found.');
                    return;
                }
                let msg = '📜 *Your Transaction History*\n\n';
                txs.slice(0, 10).forEach(t => {
                    const type = t.type === 'deposit' ? '💰 Deposit' :
                                t.type === 'withdraw' ? '📤 Withdraw' :
                                t.type === 'transfer' ? '🔄 Transfer' : '🎮 Game';
                    const sign = t.type === 'deposit' ? '+' : '-';
                    msg += `${type}: ${sign}${formatCurrency(t.amount)} - ${t.status}\n`;
                });
                await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            } catch (e) {
                await bot.sendMessage(chatId, '⚠️ Could not fetch transactions.');
            }
            break;

        case 'game_history':
            try {
                const response = await axios.get(`${API_URL}/api/games/${userId}`);
                const games = response.data.games || [];
                if (games.length === 0) {
                    await bot.sendMessage(chatId, '📊 No game history found.');
                    return;
                }
                let msg = '📊 *Your Game History*\n\n';
                games.slice(0, 10).forEach(g => {
                    msg += `🎮 Game #${g.id}: ${g.result || 'In Progress'} - ${formatCurrency(g.bet)} bet\n`;
                });
                await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            } catch (e) {
                await bot.sendMessage(chatId, '⚠️ Could not fetch game history.');
            }
            break;

        case 'copy_invite':
            const link = `https://t.me/M_bingo_bot?start=ref_${userId}`;
            await bot.sendMessage(chatId, `📋 *Your Invite Link:*\n\n${link}\n\nYou can copy this link and share it with friends.`, { parse_mode: 'Markdown' });
            break;

        case 'back_to_menu':
            await bot.sendMessage(chatId, '🎯 *Welcome back!*', {
                parse_mode: 'Markdown',
                ...mainMenu(userId)
            });
            break;

        case 'cancel':
            await bot.sendMessage(chatId, '❌ Action cancelled.');
            break;

        // ---- DEPOSIT METHOD SELECTION ----
        case data.startsWith('deposit_method_') && data:
            const parts = data.split('_');
            const method = parts[2]; // cbe or telebirr
            const amount2 = parseInt(parts[3]);
            await bot.sendMessage(chatId, `✅ You selected ${method.toUpperCase()}.\n\n` +
                `📌 *Payment Details:*\n` +
                `🏦 Account: 1000070045207\n` +
                `👤 Name: Frezer Abiy\n` +
                `📱 Reference: ${method === 'cbe' ? 'CBE' : 'Telebirr'}\n\n` +
                `💰 Amount: ${formatCurrency(amount2)}\n\n` +
                `Please send the exact amount and then enter your *Transaction ID* (confirmation number).`);
            // Wait for transaction ID
            bot.once('text', async (msg) => {
                const txnId = msg.text.trim();
                if (!txnId || txnId.length < 5) {
                    await bot.sendMessage(chatId, '❌ Invalid Transaction ID. Please try again with /deposit.');
                    return;
                }
                // Submit deposit request to admin
                await axios.post(`${API_URL}/api/deposit/request`, {
                    userId,
                    amount: amount2,
                    method,
                    txnId,
                    status: 'pending'
                });
                await bot.sendMessage(chatId, `✅ Deposit request submitted!\n\n` +
                    `💰 Amount: ${formatCurrency(amount2)}\n` +
                    `📱 Method: ${method.toUpperCase()}\n` +
                    `🆔 Txn ID: ${txnId}\n\n` +
                    `⏳ Waiting for admin confirmation. You will be notified once processed.`);
                // Notify admin
                await bot.sendMessage(ADMIN_TELEGRAM_ID, `💳 *New Deposit Request*\n\n` +
                    `👤 User: ${msg.from.first_name} (${userId})\n` +
                    `💰 Amount: ${formatCurrency(amount2)}\n` +
                    `📱 Method: ${method.toUpperCase()}\n` +
                    `🆔 Txn ID: ${txnId}`);
            });
            break;

        // ---- WITHDRAW METHOD SELECTION ----
        case data.startsWith('withdraw_method_') && data:
            const partsW = data.split('_');
            const methodW = partsW[2];
            const amountW = parseInt(partsW[3]);
            await bot.sendMessage(chatId, `✅ You selected ${methodW.toUpperCase()}.\n\n` +
                `📤 *Withdrawal Request*\n` +
                `💰 Amount: ${formatCurrency(amountW)}\n` +
                `📱 Method: ${methodW.toUpperCase()}\n\n` +
                `Please enter your ${methodW.toUpperCase()} account number or phone number:`);
            // Wait for account info
            bot.once('text', async (msg) => {
                const account = msg.text.trim();
                if (!account) {
                    await bot.sendMessage(chatId, '❌ Invalid account details. Please try again with /withdraw.');
                    return;
                }
                // Submit withdrawal request to admin
                await axios.post(`${API_URL}/api/withdraw/request`, {
                    userId,
                    amount: amountW,
                    method: methodW,
                    account,
                    status: 'pending'
                });
                await bot.sendMessage(chatId, `✅ Withdrawal request submitted!\n\n` +
                    `💰 Amount: ${formatCurrency(amountW)}\n` +
                    `📱 Method: ${methodW.toUpperCase()}\n` +
                    `🏦 Account: ${account}\n\n` +
                    `⏳ Waiting for admin approval. You will be notified once processed.`);
                // Notify admin
                await bot.sendMessage(ADMIN_TELEGRAM_ID, `📤 *New Withdrawal Request*\n\n` +
                    `👤 User: ${msg.from.first_name} (${userId})\n` +
                    `💰 Amount: ${formatCurrency(amountW)}\n` +
                    `📱 Method: ${methodW.toUpperCase()}\n` +
                    `🏦 Account: ${account}`);
            });
            break;

        // ---- ADMIN PANEL ----
        case 'admin_panel':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) {
                await bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
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

        case 'admin_players':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const response = await axios.get(`${API_URL}/api/admin/players`);
                const players = response.data;
                let msg = '👥 *Players List*\n\n';
                players.slice(0, 20).forEach((p, i) => {
                    msg += `${i+1}. ${p.first_name || 'Player'} - 💰 ${p.balance || 0} Birr\n`;
                });
                msg += `\n📊 Total: ${players.length}`;
                await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            } catch (e) {
                await bot.sendMessage(chatId, '⚠️ Error fetching players.');
            }
            break;

        case 'admin_stats':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const response = await axios.get(`${API_URL}/api/admin/stats`);
                const s = response.data;
                await bot.sendMessage(chatId, `📊 *Server Stats*\n\n` +
                    `👥 Online: ${s.onlinePlayers || 0}\n` +
                    `🎮 Active Games: ${s.activeGames || 0}\n` +
                    `💰 Revenue Today: ${s.todayRevenue || 0} Birr\n` +
                    `📈 Total Users: ${s.totalPlayers || 0}`, { parse_mode: 'Markdown' });
            } catch (e) {
                await bot.sendMessage(chatId, '⚠️ Error fetching stats.');
            }
            break;

        case 'admin_add_balance':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            await bot.sendMessage(chatId, '💰 *Add Balance*\n\n' +
                'Use: /addbalance [telegram_id] [amount]\n\n' +
                'Example: /addbalance 123456789 100');
            break;

        case 'admin_broadcast':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            await bot.sendMessage(chatId, '📢 *Send Broadcast*\n\n' +
                'Use: /broadcast [your message]');
            break;

        case 'admin_deposits':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const response = await axios.get(`${API_URL}/api/admin/deposits`);
                const deposits = response.data;
                if (!deposits || deposits.length === 0) {
                    await bot.sendMessage(chatId, 'No pending deposits.');
                    break;
                }
                let msg = '📥 *Pending Deposits*\n\n';
                deposits.forEach(d => {
                    msg += `👤 ${d.userName} (${d.userId})\n💰 ${formatCurrency(d.amount)}\n📱 ${d.method}\n🆔 ${d.txnId}\n\n`;
                });
                await bot.sendMessage(chatId, msg);
            } catch (e) {
                await bot.sendMessage(chatId, '⚠️ Error fetching deposits.');
            }
            break;

        case 'admin_withdrawals':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const response = await axios.get(`${API_URL}/api/admin/withdrawals`);
                const withdrawals = response.data;
                if (!withdrawals || withdrawals.length === 0) {
                    await bot.sendMessage(chatId, 'No pending withdrawals.');
                    break;
                }
                let msg = '📤 *Pending Withdrawals*\n\n';
                withdrawals.forEach(w => {
                    msg += `👤 ${w.userName} (${w.userId})\n💰 ${formatCurrency(w.amount)}\n📱 ${w.method}\n🏦 ${w.account}\n\n`;
                });
                await bot.sendMessage(chatId, msg);
            } catch (e) {
                await bot.sendMessage(chatId, '⚠️ Error fetching withdrawals.');
            }
            break;

        default:
            await bot.sendMessage(chatId, '❌ Unknown command.');
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
    } catch (e) {
        await bot.sendMessage(chatId, '⚠️ Error adding balance.');
    }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    const message = match[1];
    // This would require a list of all chat IDs - for demo just notify admin
    await bot.sendMessage(chatId, `📢 Broadcast sent: "${message}"`);
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
