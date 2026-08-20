// ============================================================
// M-BINGO TELEGRAM BOT - PRODUCTION VERSION (ADVANCED MENU)
// @M_bingo_bot
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is required. Set it in the deployment environment.');
}
const API_URL = process.env.API_URL || 'https://m-bingo-server.onrender.com';
const REQUEST_TIMEOUT = Number(process.env.API_TIMEOUT_MS || 8000);
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_IDS = (process.env.ADMIN_IDS || '555508978').split(',').map(id => parseInt(id.trim()));

// ============================================================
// EXPRESS SERVER SETUP
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================================
// TELEGRAM BOT SETUP
// ============================================================

const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });
axios.defaults.timeout = REQUEST_TIMEOUT;

console.log('🤖 M-BINGO Bot starting...');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎮 Game URL: ${GAME_URL}`);
console.log(`👑 Admin IDs: ${ADMIN_IDS}`);

// ============================================================
// DATABASE MODEL (Example using MongoDB/Mongoose)
// ============================================================

// If you're using MongoDB with Mongoose, uncomment this:
/*
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI);

const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    phone: String,
    balance: { type: Number, default: 0 },
    cards: { type: [Number], default: [] },
    gamesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    totalWinnings: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
*/

// For now, we'll use an in-memory store (for testing)
// Replace this with your actual database
const users = {};

// ============================================================
// ADMIN API ENDPOINTS
// ============================================================

// Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Check if user is admin (username must match an admin ID)
        const isAdmin = ADMIN_IDS.some(id => id.toString() === username);
        
        if (!isAdmin) {
            return res.status(401).json({
                success: false,
                message: 'Invalid admin credentials'
            });
        }
        
        res.json({
            success: true,
            message: 'Admin login successful',
            adminId: username
        });
        
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get admin data endpoint
app.get('/api/admin/data', async (req, res) => {
    try {
        const adminId = req.query.adminId;
        
        if (!ADMIN_IDS.includes(parseInt(adminId))) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }
        
        // For testing with in-memory data
        const players = Object.values(users).map(u => ({
            id: u.telegramId,
            name: u.firstName || u.username || 'Player',
            balance: u.balance || 0,
            cards: u.cards || []
        }));
        
        res.json({
            success: true,
            players: players
        });
        
    } catch (error) {
        console.error('Error fetching admin data:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Admin action endpoint
app.post('/api/admin/action', async (req, res) => {
    try {
        const { adminId, action, playerId, amount, txnId, method, address, phone } = req.body;
        
        // Verify admin
        if (!ADMIN_IDS.includes(parseInt(adminId))) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }
        
        let user;
        let result = {};
        
        // Find user (in-memory for testing)
        user = Object.values(users).find(u => u.telegramId === parseInt(playerId) || u.id === playerId);
        
        if (!user) {
            // If user not found in memory, try to fetch from main API
            try {
                const response = await axios.get(`${API_URL}/api/users/${playerId}`);
                user = response.data.user;
                // Store in memory
                users[user.telegramId] = user;
            } catch (err) {
                return res.status(404).json({ success: false, message: 'User not found' });
            }
        }
        
        switch (action) {
            case 'deposit':
                user.balance = (user.balance || 0) + amount;
                result = { newBalance: user.balance };
                break;
                
            case 'withdraw':
                if ((user.balance || 0) < amount) {
                    return res.status(400).json({ success: false, message: 'Insufficient balance' });
                }
                user.balance = (user.balance || 0) - amount;
                result = { newBalance: user.balance };
                break;
                
            case 'transfer':
                // Find user by phone
                const targetUser = Object.values(users).find(u => u.phone === phone);
                if (!targetUser) {
                    return res.status(404).json({ success: false, message: 'Target user not found' });
                }
                if ((user.balance || 0) < amount) {
                    return res.status(400).json({ success: false, message: 'Insufficient balance' });
                }
                user.balance = (user.balance || 0) - amount;
                targetUser.balance = (targetUser.balance || 0) + amount;
                result = { success: true };
                break;
                
            default:
                return res.status(400).json({ success: false, message: 'Invalid action' });
        }
        
        // In a real app, save to database here
        // await user.save();
        
        res.json({
            success: true,
            ...result
        });
        
    } catch (error) {
        console.error('Admin action error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// ============================================================
// MAIN MENU
// ============================================================

function mainMenu(userId) {
    const isAdmin = ADMIN_IDS.includes(userId);
    
    const buttons = [
        [{ text: "🎮 Play Now", web_app: { url: GAME_URL } }],
        [
            { text: "💰 Check Balance", callback_data: 'balance' },
            { text: "🏦 Make a Deposit", callback_data: 'deposit_info' }
        ],
        [
            { text: "📞 Support", callback_data: 'support' },
            { text: "📖 Instructions", callback_data: 'rules' }
        ],
        [
            { text: "📩 Invite", callback_data: 'invite' },
            { text: "🏆 Win Patterns", callback_data: 'patterns' }
        ],
        [
            { text: "👤 Change Username", callback_data: 'change_username' },
            { text: "🏆 Leaderboard", callback_data: 'leaderboard' }
        ]
    ];
    
    if (isAdmin) {
        buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    }
    
    return {
        reply_markup: {
            inline_keyboard: buttons,
            resize_keyboard: true
        }
    };
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

// /start command - Updated with auto-registration
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const username = msg.from.username || `user_${userId}`;
    const referralId = match ? match[1] : null;
    
    let userData = null;
    let isNewUser = false;
    
    try {
        // Store user in memory for admin panel
        if (!users[userId]) {
            users[userId] = {
                telegramId: userId,
                username: username,
                firstName: firstName,
                lastName: msg.from.last_name || '',
                balance: 0,
                cards: [],
                gamesPlayed: 0,
                wins: 0,
                totalWinnings: 0,
                createdAt: new Date()
            };
            isNewUser = true;
            console.log(`✅ New user registered: ${firstName} (${userId})`);
        } else {
            userData = users[userId];
            console.log(`👋 Existing user logged in: ${firstName} (${userId})`);
        }
        
        // Also register with main API
        await axios.post(`${API_URL}/api/users/register`, {
            telegramId: userId,
            username: username,
            firstName: firstName,
            lastName: msg.from.last_name || '',
        }, {
            headers: { 'x-bot-token': BOT_TOKEN }
        });
        
    } catch (error) {
        console.log('⚠️ Registration check:', error.message);
    }
    
    let welcomeText;
    if (isNewUser) {
        welcomeText = `
🎯 *Welcome to M-BINGO, ${firstName}!* 🎉

💰 *You start with 0 Birr!*
📝 *Your account has been created successfully!*

📌 *How to Play:*
1️⃣ Tap "🎮 Play Now" below
2️⃣ Select your stake (10, 20, 30, 40, 50 or 100 Birr)
3️⃣ Choose 1-5 BINGO cards
4️⃣ Wait for 2+ players
5️⃣ Game starts automatically!
6️⃣ First to complete a pattern wins! 🏆

🎁 *Prize:* 70% of total bets!

👇 *Tap the button below to open the game:*
    `;
    } else {
        const balance = userData?.balance || 0;
        welcomeText = `
👋 *Welcome back to M-BINGO, ${firstName}!* 🎯

💰 *Your Balance:* ${balance} Birr
🎴 *Cards Selected:* ${userData?.cards?.length || 0}
🏆 *Games Played:* ${userData?.gamesPlayed || 0}
🎖️ *Wins:* ${userData?.wins || 0}

👇 *Tap the button below to open the game:*
    `;
    }
    
    const inlineKeyboard = [
        [{ text: "🎮 Play Now", web_app: { url: GAME_URL } }]
    ];
    
    await bot.sendMessage(chatId, welcomeText, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: inlineKeyboard
        }
    });

    await bot.sendMessage(chatId, "👇 *Select an option below:*", { 
        ...mainMenu(userId),
        parse_mode: 'Markdown'
    });
});

// Rest of your bot commands remain the same...
// (balance, invite, deposit, withdraw, transfer, winners, etc.)

// ============================================================
// START THE SERVER AND BOT
// ============================================================

// Start Express server
app.listen(PORT, () => {
    console.log(`🌐 Admin API server running on port ${PORT}`);
    console.log(`📍 Admin API URL: http://localhost:${PORT}/api/admin`);
});

console.log('✅ M-BINGO Bot is running with Advanced Menu!');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`📡 API URL: ${API_URL}`);
console.log('👑 Admin IDs:', ADMIN_IDS);

// Setup WebApp menu
try {
    bot.setChatMenuButton({
        menu_button: {
            type: 'web_app',
            text: '🎮 Play M-BINGO',
            web_app: {
                url: GAME_URL
            }
        }
    });
    console.log('✅ Telegram Web App menu button configured');
} catch (error) {
    console.error('⚠️ Failed to configure menu button:', error.message);
}
