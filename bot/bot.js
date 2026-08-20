// ============================================================
// M-BINGO TELEGRAM BOT - RENDER DEPLOYMENT
// Using your existing environment variables
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// ============================================================
// CONFIGURATION - Using your Render env variables
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
const ALLOW_BROWSER_TESTING = process.env.ALLOW_BROWSER_TESTING === 'true';

console.log('🤖 M-BINGO Bot Configuration:');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎮 Game URL: ${GAME_URL}`);
console.log(`👑 Admin ID: ${ADMIN_TELEGRAM_ID}`);
console.log(`🌐 Port: ${PORT}`);
console.log(`🧪 Browser Testing: ${ALLOW_BROWSER_TESTING}`);

// ============================================================
// DATABASE CONNECTION (PostgreSQL on Render)
// ============================================================

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.stack);
    } else {
        console.log('✅ Database connected successfully');
        release();
    }
});

// ============================================================
// EXPRESS SERVER
// ============================================================

const app = express();
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io',
    credentials: true
}));
app.use(express.json());

// Health check
app.get('/health', async (req, res) => {
    try {
        // Check database
        await pool.query('SELECT NOW()');
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: 'connected',
            bot: 'M-BINGO Bot',
            version: '2.0.0'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            database: 'disconnected',
            error: error.message
        });
    }
});

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        console.log(`🔐 Admin login attempt: ${username}`);
        
        // Check username
        if (username !== ADMIN_USERNAME) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }
        
        // Check password hash
        if (ADMIN_PASSWORD_HASH) {
            const isValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
            if (!isValid) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid credentials'
                });
            }
        } else if (password !== 'admin123') {
            // Fallback for testing
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }
        
        res.json({
            success: true,
            message: 'Admin login successful',
            adminId: ADMIN_TELEGRAM_ID,
            username: ADMIN_USERNAME
        });
        
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get Admin Data
app.get('/api/admin/data', async (req, res) => {
    try {
        const adminId = req.query.adminId;
        
        if (adminId !== ADMIN_TELEGRAM_ID) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }
        
        // Fetch players from your backend API
        const response = await axios.get(`${API_URL}/api/admin/players`);
        
        res.json({
            success: true,
            players: response.data || []
        });
        
    } catch (error) {
        console.error('Error fetching admin data:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching players'
        });
    }
});

// Admin Actions
app.post('/api/admin/action', async (req, res) => {
    try {
        const { adminId, action, playerId, amount } = req.body;
        
        if (adminId !== ADMIN_TELEGRAM_ID) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }
        
        // Forward to your backend API
        const response = await axios.post(`${API_URL}/api/admin/action`, {
            adminId,
            action,
            playerId,
            amount
        });
        
        res.json(response.data);
        
    } catch (error) {
        console.error('Admin action error:', error);
        res.status(500).json({
            success: false,
            message: error.response?.data?.message || 'Action failed'
        });
    }
});

// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: { 
        interval: 1000, 
        autoStart: true 
    } 
});

// ============================================================
// MAIN MENU
// ============================================================

function mainMenu(userId) {
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    
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
            { text: "👤 Profile", callback_data: 'profile' },
            { text: "🏆 Leaderboard", callback_data: 'leaderboard' }
        ]
    ];
    
    if (isAdmin) {
        buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    }
    
    return {
        reply_markup: {
            inline_keyboard: buttons
        }
    };
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

// /start command
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const username = msg.from.username || `user_${userId}`;
    
    try {
        // Register user with your Render backend
        const response = await axios.post(`${API_URL}/api/users/register`, {
            telegramId: userId,
            username: username,
            firstName: firstName,
            lastName: msg.from.last_name || '',
        });
        
        console.log(`✅ User registered: ${firstName} (${userId})`);
        
        // Check if user is admin
        if (userId.toString() === ADMIN_TELEGRAM_ID) {
            console.log('👑 Admin user logged in');
        }
        
    } catch (error) {
        console.log('⚠️ Registration check:', error.message);
    }
    
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const adminBadge = isAdmin ? ' 👑' : '';
    
    const welcomeText = `
🎯 *Welcome to M-BINGO, ${firstName}!*${adminBadge}

💰 *Your Balance:* 0 Birr

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

// /balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const response = await axios.get(`${API_URL}/api/wallet/${userId}`);
        const data = response.data;
        
        const message = `
*Username:*   ${data.first_name || 'Player'}
*Balance:*    ${data.balance || 0}.00 ETB
        `;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Could not fetch balance. Please play a game first.');
    }
});

// /invite command
bot.onText(/\/invite/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    
    const inviteLink = `https://t.me/M_bingo_bot?start=ref_${userId}`;
    
    const message = `
🎉 Hello ${firstName}!

Here is your unique invite link to share with friends:

${inviteLink}

Invite people and get paid!
    `;
    
    bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "📤 Share Invite Link", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}` }]
            ]
        }
    });
});

// /profile command
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
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Could not fetch profile.');
    }
});

// /admin command
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId.toString() !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, '⛔ Unauthorized. You are not an admin.');
        return;
    }
    
    bot.sendMessage(chatId, '👑 *Admin Panel*\n\nWelcome Admin!', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 Players List', callback_data: 'admin_players' }],
                [{ text: '📊 Server Stats', callback_data: 'admin_stats' }],
                [{ text: '💰 Add Balance', callback_data: 'admin_add_balance' }],
                [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
                [{ text: '🔙 Back to Main Menu', callback_data: 'back_to_menu' }]
            ]
        }
    });
});

// ============================================================
// CALLBACK QUERY HANDLERS
// ============================================================

bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    const messageId = call.message.message_id;
    
    bot.answerCallbackQuery(call.id);
    
    switch (data) {
        case 'balance':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance');
            break;
            
        case 'deposit_info':
            bot.sendMessage(chatId, `
🏦 *Make a Deposit*

📌 *Minimum:* 50 ETB
📌 *Maximum:* 5000 ETB

💰 *Payment Methods:*
• Telebirr
• CBE Birr
• Bank Transfer

📞 *Contact Support:* @frezerabiy
            `, { parse_mode: 'Markdown' });
            break;
            
        case 'invite':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/invite');
            break;
            
        case 'profile':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/profile');
            break;
            
        case 'support':
            bot.sendMessage(chatId, "📞 Contact @frezerabiy for support.");
            break;
            
        case 'rules':
            bot.sendMessage(chatId, `
📖 *BINGO Game Instructions*

1️⃣ *Start:* Tap "🎮 Play Now" below
2️⃣ *Select Stake:* Choose your bet amount
3️⃣ *Pick Cards:* Select 1-5 BINGO cards
4️⃣ *Multiplayer:* Wait for 2+ players
5️⃣ *Game Start:* Numbers are called automatically
6️⃣ *Win:* First player to complete a pattern wins 70%!

💰 *Good luck and have fun!*
            `, { parse_mode: 'Markdown' });
            break;
            
        case 'patterns':
            bot.sendMessage(chatId, `
🏆 *Winning Patterns*

✅ Row - 5 numbers in a horizontal line
✅ Column - 5 numbers in a vertical line
✅ Diagonal - 5 numbers diagonally
✅ Corners - All 4 corners
✅ Full House - All numbers on card
            `, { parse_mode: 'Markdown' });
            break;
            
        case 'leaderboard':
            bot.sendMessage(chatId, "🏆 Leaderboard is under development. Stay tuned!");
            break;
            
        case 'admin_panel':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/admin');
            break;
            
        case 'admin_players':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            try {
                const response = await axios.get(`${API_URL}/api/admin/players`);
                const players = response.data;
                
                if (!players || players.length === 0) {
                    bot.sendMessage(chatId, 'No players found.');
                    break;
                }
                
                let message = '👥 *Players List*\n\n';
                players.slice(0, 20).forEach((p, i) => {
                    message += `${i+1}. ${p.first_name || 'Player'} - 💰 ${p.balance || 0} Birr\n`;
                });
                message += `\n📊 *Total:* ${players.length} players`;
                
                bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } catch (error) {
                bot.sendMessage(chatId, '⚠️ Error fetching players.');
            }
            break;
            
        case 'admin_add_balance':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, '💰 *Add Balance*\n\nUse: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 555508978 100');
            break;
            
        case 'admin_stats':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            try {
                const response = await axios.get(`${API_URL}/api/admin/stats`);
                const s = response.data;
                bot.sendMessage(chatId, `
📊 *Server Stats*

👥 Online Players: ${s.onlinePlayers || 0}
🎮 Active Games: ${s.activeGames || 0}
💰 Today's Revenue: ${s.todayRevenue || 0} Birr
📈 Total Users: ${s.totalPlayers || 0}
                `, { parse_mode: 'Markdown' });
            } catch (error) {
                bot.sendMessage(chatId, '⚠️ Error fetching stats.');
            }
            break;
            
        case 'admin_broadcast':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, '📢 *Send Broadcast*\n\nUse: /broadcast [your message]');
            break;
            
        case 'back_to_menu':
            bot.editMessageText('🎯 *Welcome back!*\n\nSelect an option below:', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                ...mainMenu(userId)
            });
            break;
    }
});

// ============================================================
// ADMIN COMMANDS
// ============================================================

// /addbalance command
bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId.toString() !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    
    try {
        await axios.post(`${API_URL}/api/admin/balance/add`, {
            userId: targetId,
            amount: amount,
            adminId: userId
        });
        bot.sendMessage(chatId, `✅ Added ${amount} Birr to player!`);
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error adding balance.');
    }
});

// /broadcast command
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId.toString() !== ADMIN_TELEGRAM_ID) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    const message = match[1];
    bot.sendMessage(chatId, `📢 Broadcast sent: "${message}"`);
    // In production, you would fetch all users and send to each
});

// ============================================================
// START SERVER AND BOT
// ============================================================

// Start Express server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Admin API server running on port ${PORT}`);
    console.log(`📍 Admin API URL: http://localhost:${PORT}/api/admin`);
});

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

console.log('✅ M-BINGO Bot is running!');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`📡 API URL: ${API_URL}`);
console.log(`👑 Admin ID: ${ADMIN_TELEGRAM_ID}`);

// Error handlers
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});
