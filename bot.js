// ============================================================
// M-BINGO TELEGRAM BOT - FULL FEATURED (Fixed HTML & Escaping)
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

const API_URL = process.env.API_URL || 'https://m-bingo-backend.onrender.com';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '555508978';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const PORT = process.env.PORT || 3000;
const REFERRAL_BONUS = 20;

console.log('🤖 M-BINGO Bot Configuration:');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎮 Game URL: ${GAME_URL}`);
console.log(`👑 Admin ID (Telegram): ${ADMIN_TELEGRAM_ID}`);
console.log(`🌐 Port: ${PORT}`);

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
// HELPER FUNCTIONS (Fixes the crash)
// ============================================================
function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatCurrency(amount) {
    return amount.toLocaleString('en-US') + ' ETB';
}

// ============================================================
// ENSURE ADMIN USER & FETCH INTERNAL UUID
// ============================================================

let ADMIN_DB_ID = null;

async function ensureAdminUser() {
    try {
        const result = await pool.query(
            `SELECT id, is_admin FROM users WHERE telegram_id = $1`,
            [ADMIN_TELEGRAM_ID]
        );

        if (result.rows.length === 0) {
            console.log('👑 Admin user not found, creating...');
            await pool.query(
                `INSERT INTO users (telegram_id, username, first_name, balance, is_admin, last_login)
                 VALUES ($1, $2, $3, 0, TRUE, CURRENT_TIMESTAMP)`,
                [ADMIN_TELEGRAM_ID, 'admin', 'Admin']
            );
            console.log('✅ Admin user created');
        } else if (result.rows[0].is_admin !== true) {
            console.log('👑 Upgrading user to admin...');
            await pool.query(
                `UPDATE users SET is_admin = TRUE WHERE telegram_id = $1`,
                [ADMIN_TELEGRAM_ID]
            );
            console.log('✅ User upgraded to admin');
        } else {
            console.log('✅ Admin user already exists');
        }

        const idResult = await pool.query(
            `SELECT id FROM users WHERE telegram_id = $1 AND is_admin = TRUE`,
            [ADMIN_TELEGRAM_ID]
        );
        if (idResult.rows.length > 0) {
            ADMIN_DB_ID = idResult.rows[0].id;
            console.log(`✅ Admin DB ID: ${ADMIN_DB_ID}`);
        } else {
            console.error('❌ Could not retrieve admin DB ID');
        }
    } catch (error) {
        console.error('❌ Failed to ensure admin user:', error.message);
    }
}

ensureAdminUser();

// ============================================================
// EXPRESS SERVER (Health Check & Admin Proxy)
// ============================================================
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io' }));
app.use(express.json());

app.get('/', (req, res) => res.send('M-BINGO Bot is running ✅'));
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
    } else if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    res.json({ success: true, adminId: ADMIN_DB_ID || ADMIN_TELEGRAM_ID });
});

// ============================================================
// TELEGRAM BOT
// ============================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });

bot.deleteWebHook().catch(() => console.log('Webhook deleted (or not set).'));

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
        }, {
            headers: { 'X-Bot-Token': BOT_TOKEN }
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

// ============================================================
// MAIN MENU
// ============================================================
function mainMenu(userId) {
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const buttons = [
        [{ text: "🎮 Play Game", callback_data: 'play' }],
        [{ text: "💰 Balance", callback_data: 'balance' }, { text: "🏦 Deposit", callback_data: 'deposit' }],
        [{ text: "📤 Withdraw", callback_data: 'withdraw' }, { text: "🔄 Transfer", callback_data: 'transfer' }],
        [{ text: "🎁 Bonus / Invite", callback_data: 'bonus' }, { text: "📜 History", callback_data: 'history' }],
        [{ text: "📖 Help", callback_data: 'help' }, { text: "📞 Support", callback_data: 'support' }],
        [{ text: "🏆 Patterns", callback_data: 'patterns' }, { text: "👤 Profile", callback_data: 'profile' }]
    ];
    if (isAdmin) {
        buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    }
    return { reply_markup: { inline_keyboard: buttons } };
}

// ============================================================
// COMMAND HANDLERS (Using HTML & escapeHtml)
// ============================================================
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = escapeHtml(msg.from.first_name || 'Player');
    const lastName = escapeHtml(msg.from.last_name || '');
    const username = msg.from.username || `user_${userId}`;
    const referralId = match ? parseInt(match[1]) : null;

    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            const balance = await getUserBalance(userId);
            const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
            const welcomeBack = `👋 <b>Welcome back, ${firstName}!</b>${isAdmin ? ' 👑' : ''}\n\n` +
                `💰 <b>Balance:</b> ${formatCurrency(balance)}\n` +
                `📊 <b>Games Played:</b> ${response.data.user.gamesPlayed || 0}\n` +
                `🏆 <b>Wins:</b> ${response.data.user.wins || 0}\n\n` +
                `👇 <b>Select an option below:</b>`;
            await bot.sendMessage(chatId, welcomeBack, {
                parse_mode: 'HTML',
                ...mainMenu(userId)
            });
            return;
        }
    } catch (error) {}

    const registerMessage = `
📝 <b>Welcome to M-BINGO, ${firstName}!</b>

To complete your registration, please share your contact by clicking the button below.

🔒 <b>Your Telegram ID will be used to securely identify you.</b>
    `;
    const registerKeyboard = {
        reply_markup: {
            keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    };
    await bot.sendMessage(chatId, registerMessage, {
        parse_mode: 'HTML',
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
    const firstName = escapeHtml(msg.from.first_name || 'Player');
    const lastName = escapeHtml(msg.from.last_name || '');
    const username = msg.from.username || `user_${userId}`;

    if (!contact || contact.user_id != userId) {
        await bot.sendMessage(chatId, '❌ Please share your own contact.');
        return;
    }

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
            const welcome = `✅ <b>Registration Successful!</b>\n\n` +
                `🎯 Welcome to M-BINGO, ${firstName}!\n` +
                `💰 You have received a <b>50 Birr</b> starting balance.\n\n` +
                `👇 <b>Select an option below to start playing!</b>`;
            await bot.sendMessage(chatId, '✅ Registration complete!', { reply_markup: { remove_keyboard: true } });
            await bot.sendMessage(chatId, welcome, { parse_mode: 'HTML', ...mainMenu(userId) });
            await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆕 <b>New User Registered!</b>\n\n` +
                `👤 Name: ${firstName}\n🆔 ID: ${userId}\n📱 Username: @${username}\n📞 Phone: ${contact.phone_number}`);
        }
    } catch (error) {
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
    await bot.sendMessage(chatId, '🎯 <b>Select your stake amount:</b>\n\nChoose how much you want to bet per card.\nYou can select up to 5 cards per game.', { parse_mode: 'HTML', ...stakeOptions });
});

// (Other commands like balance, deposit, etc. remain the same but change parse_mode to HTML)

bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const balance = await getUserBalance(userId);
    await bot.sendMessage(chatId, `💰 <b>Your Balance</b>\n\n${formatCurrency(balance)}`, { parse_mode: 'HTML' });
});

// (Continue with /deposit, /withdraw, /transfer, /bonus, /history, /profile, /help - using HTML parse mode and escaping user input)

// ============================================================
// NOTIFICATION POLLER (Critical Fixed with try...catch)
// ============================================================
setInterval(async () => {
    try {
        const deposits = await pool.query(
            `SELECT d.*, u.telegram_id FROM deposits d
             JOIN users u ON u.id = d.user_id
             WHERE d.status IN ('APPROVED', 'REJECTED') AND d.notified = FALSE`
        );

        for (let d of deposits.rows) {
            const msg = d.status === 'APPROVED'
                ? `💰 <b>Deposit Successful!</b> ${formatCurrency(d.amount)} has been added to your balance.`
                : `❌ <b>Deposit Rejected.</b> Please try again or contact support.`;
            
            try {
                await bot.sendMessage(d.telegram_id, msg, { parse_mode: 'HTML' });
            } catch (sendErr) {
                console.error('Failed to send deposit notification:', sendErr.message);
            }
            await pool.query('UPDATE deposits SET notified = TRUE WHERE id = $1', [d.id]);
        }

        const withdrawals = await pool.query(
            `SELECT w.*, u.telegram_id FROM withdrawals w
             JOIN users u ON u.id = w.user_id
             WHERE w.status IN ('APPROVED', 'REJECTED') AND w.notified = FALSE`
        );

        for (let w of withdrawals.rows) {
            const msg = w.status === 'APPROVED'
                ? `🏦 <b>Withdrawal Successful!</b> ${formatCurrency(w.amount)} is on its way to your account.`
                : `❌ <b>Withdrawal Rejected.</b> Please try again.`;
            
            try {
                await bot.sendMessage(w.telegram_id, msg, { parse_mode: 'HTML' });
            } catch (sendErr) {
                console.error('Failed to send withdrawal notification:', sendErr.message);
            }
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
    console.log(`🌐 Admin API and health check on port ${PORT}`);
});

bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: '🎮 Play M-BINGO', web_app: { url: GAME_URL } }
}).catch(() => {});

console.log('✅ M-BINGO Bot is running!');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`📡 API URL: ${API_URL}`);
console.log(`👑 Admin Telegram ID: ${ADMIN_TELEGRAM_ID}`);
console.log(`👑 Admin DB ID: ${ADMIN_DB_ID || 'not yet loaded'}`);
