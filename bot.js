// ============================================================
// M-BINGO TELEGRAM BOT - PRODUCTION VERSION (ADVANCED MENU)
// @M_bingo_bot
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
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

const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });
axios.defaults.timeout = REQUEST_TIMEOUT;

console.log('🤖 M-BINGO Bot starting...');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎮 Game URL: ${GAME_URL}`);
console.log(`👑 Admin IDs: ${ADMIN_IDS}`);

// ============================================================
// MAIN MENU (Matches Image 2 - Large 2-Column Grid)
// ============================================================

function mainMenu(userId) {
    const isAdmin = ADMIN_IDS.includes(userId);
    
    // The main grid layout
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
    
    // Add Admin Panel button if user is admin
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

// /start command - Welcomes user and registers them
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const referralId = match ? match[1] : null;
    
    try {
        // Register user automatically (Use existing API)
        await axios.post(`${API_URL}/api/users/register`, {
            telegramId: userId,
            username: msg.from.username || '',
            firstName: firstName,
            lastName: msg.from.last_name || '',
        }, {
            headers: { 'x-bot-token': BOT_TOKEN }
        });
    } catch (error) {
        console.log('Registration info (user may already exist):', error.message);
    }
    
    const welcomeText = `
🎯 *Welcome to M-BINGO, ${firstName}!*

💰 *You start with 500 Birr bonus!*

📌 *How to Play:*
1️⃣ Click "🎮 Play Now" below
2️⃣ Select your stake (10, 20, 30, 40, 50 or 100 Birr)
3️⃣ Choose 1-5 BINGO cards
4️⃣ Wait for 2+ players
5️⃣ Game starts automatically!
6️⃣ First to complete a pattern wins! 🏆

🎁 *Prize:* 70% of total bets!

👇 *Select an option below to get started:*
    `;
    
    bot.sendMessage(chatId, welcomeText, { 
        ...mainMenu(userId),
        parse_mode: 'Markdown'
    });
});

// /balance command - Checks balance (Matches Image 4)
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const response = await axios.get(`${API_URL}/api/wallet/${userId}`);
        const data = response.data;
        
        const message = `
*Username:*   ${data.first_name || 'Player'}
*Balance:*    ${data.balance || 0}.00 ETB
*Coin:*       0.40
        `;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Could not fetch balance. Please play a game first.');
    }
});

// /invite command (Matches Image 6)
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

// /deposit command (Matches Image 5)
bot.onText(/\/deposit/, async (msg) => {
    const chatId = msg.chat.id;
    
    const message = `
Here are the min you can deposit
*Min Amount:*     50 ETB

Please enter the amount:
    `;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /withdraw command
bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, "📤 Please contact an admin to process your withdrawal.");
});

// /transfer command (Matches Image 3)
bot.onText(/\/transfer/, async (msg) => {
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, "📞 Enter the phone number of the person you want to transfer money to:");
});

// /winners command
bot.onText(/\/winners/, async (msg) => {
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, "🏆 Leaderboard feature coming soon!");
});

// ============================================================
// CALLBACK QUERY HANDLERS
// ============================================================

bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const messageId = call.message.message_id;
    const data = call.data;
    const userId = call.from.id;
    
    bot.answerCallbackQuery(call.id);
    
    switch (data) {
        case 'balance':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance');
            break;
            
        case 'deposit_info':
            bot.emit('text', { chat: { id: chatId } }, '/deposit');
            break;
            
        case 'invite':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/invite');
            break;
            
        case 'support':
            bot.sendMessage(chatId, "📞 Contact @frezerabiy for support.");
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
            
        case 'change_username':
            bot.sendMessage(chatId, "👤 Please contact @frezerabiy to change your username.");
            break;
            
        case 'leaderboard':
            bot.sendMessage(chatId, "🏆 Leaderboard is under development. Stay tuned!");
            break;
            
        case 'rules':
            bot.sendMessage(chatId, `
📖 *BINGO Game Instructions*

1️⃣ *Start:* Click "🎮 Play Now"
2️⃣ *Select Stake:* Choose your bet amount (10, 20, 30, 40, 50 or 100 ETB)
3️⃣ *Pick Cards:* Select 1-5 BINGO cards
4️⃣ *Multiplayer:* Wait for 2+ players
5️⃣ *Game Start:* Numbers are called automatically
6️⃣ *Win:* First player to complete a pattern wins 70% of the pot!

💰 *Good luck and have fun!*
            `, { parse_mode: 'Markdown' });
            break;
            
        case 'back_to_menu':
            bot.editMessageText('🎯 *Welcome back!*\n\nSelect an option below:', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                ...mainMenu(userId)
            });
            break;
            
        // ============================================================
        // ADMIN CALLBACKS
        // ============================================================
            
        case 'admin_panel':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, '👑 *Admin Panel*\n\nSelect an action:', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 Players List', callback_data: 'admin_players' }],
                        [{ text: '📊 Server Stats', callback_data: 'admin_stats' }],
                        [{ text: '💰 Add Balance', callback_data: 'admin_add_balance' }],
                        [{ text: '📢 Broadcast Message', callback_data: 'admin_broadcast' }],
                        [{ text: '🔙 Back to Main Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'admin_players':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/players');
            break;
            
        case 'admin_stats':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            try {
                const response = await axios.get(`${API_URL}/api/admin/stats`, {
                    params: { adminId: userId }
                });
                const s = response.data;
                bot.sendMessage(chatId, `
📊 *Server Stats*

👥 Online Players: ${s.onlinePlayers || 0}
🎮 Active Games: ${s.activeGames || 0}
💰 Today's Revenue: ${s.todayRevenue || 0} Birr
📈 Total Users: ${s.totalPlayers || 0}
🏠 Total Rooms: ${s.activeGames || 0}
                `, { parse_mode: 'Markdown' });
            } catch (error) {
                bot.sendMessage(chatId, '⚠️ Error fetching stats.');
            }
            break;
            
        case 'admin_add_balance':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, '💰 *Add Balance*\n\nUse: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 123456789 100');
            break;
            
        case 'admin_broadcast':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, '📢 *Send Broadcast*\n\nUse: /broadcast [your message]');
            break;
    }
});

// ============================================================
// ADMIN COMMANDS
// ============================================================

// /admin command
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized. You do not have admin access.');
        return;
    }
    bot.emit('callback_query', { id: 'admin_panel', data: 'admin_panel', from: { id: userId }, message: { chat: { id: chatId }, message_id: 0 } });
});

// /players command
bot.onText(/\/players/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    try {
        const response = await axios.get(`${API_URL}/api/admin/players`, {
            params: { adminId: userId }
        });
        const players = response.data;
        
        if (!players || players.length === 0) {
            bot.sendMessage(chatId, 'No players registered.');
            return;
        }
        
        let message = '👥 *Players List*\n\n';
        players.slice(0, 20).forEach(p => {
            message += `• ${p.first_name || 'Player'} - 💰 ${p.balance} Birr - 🏆 ${p.total_wins || 0} wins\n`;
        });
        message += `\n📊 *Total:* ${players.length} players`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error fetching players.');
    }
});

// /addbalance command
bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    
    try {
        const response = await axios.post(`${API_URL}/api/admin/balance/add`, {
            userId: targetId,
            amount: amount,
            adminId: userId
        });
        bot.sendMessage(chatId, `✅ Added ${amount} Birr to player! New balance: ${response.data.newBalance} Birr`);
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error adding balance.');
    }
});

// /removebalance command
bot.onText(/\/removebalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    
    try {
        const response = await axios.post(`${API_URL}/api/admin/balance/remove`, {
            userId: targetId,
            amount: amount,
            adminId: userId
        });
        bot.sendMessage(chatId, `✅ Removed ${amount} Birr from player! New balance: ${response.data.newBalance} Birr`);
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error: Insufficient balance.');
    }
});

// /broadcast command
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    const message = match[1];
    bot.sendMessage(chatId, `📢 Broadcast sent! (This feature requires a database of all chat IDs to work properly.)`);
});

// ============================================================
// INLINE QUERY HANDLER
// ============================================================

bot.on('inline_query', (query) => {
    const results = [{
        type: 'article',
        id: '1',
        title: '🎯 Play BINGO with friends!',
        description: 'Join @M_bingo_bot and win real prizes!',
        input_message_content: {
            message_text: "🎯 Join me on M-BINGO!\n\nPlay with friends and win real prizes!\n👉 @M_bingo_bot"
        },
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎮 Play BINGO', web_app: { url: GAME_URL } }],
                [{ text: '💰 Get Started', url: 'https://t.me/M_bingo_bot' }]
            ]
        }
    }];
    bot.answerInlineQuery(query.id, results);
});

// ============================================================
// ERROR HANDLER
// ============================================================

bot.on('error', (error) => {
    console.error('Bot error:', error);
});

// ============================================================
// START THE BOT
// ============================================================

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

console.log('✅ M-BINGO Bot is running with Advanced Menu!');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`📡 API URL: ${API_URL}`);
console.log('👑 Admin IDs:', ADMIN_IDS);