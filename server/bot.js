// ============================================================
// M-BINGO TELEGRAM BOT - PRODUCTION VERSION
// @M_bingo_bot
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();

// ============================================================
// CONFIGURATION - ✅ UPDATED
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN || '8312462723:AAHVyOGm7vDKJD7M_8ZceQzgvwLkMGc6dEU';
// ✅ USE RENDER URL (not localhost)
const API_URL = process.env.API_URL || 'https://m-bingo-server.onrender.com';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_IDS = (process.env.ADMIN_IDS || '555508978').split(',').map(id => parseInt(id.trim()));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('🤖 M-BINGO Bot starting...');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎯 Game URL: ${GAME_URL}`);
console.log(`👑 Admin IDs: ${ADMIN_IDS}`);

// ============================================================
// MAIN MENU
// ============================================================

function mainMenu(userId) {
    const isAdmin = ADMIN_IDS.includes(userId);
    const buttons = [
        [{ text: '🎯 Play BINGO', web_app: { url: GAME_URL } }],
        [{ text: '💰 Balance', callback_data: 'balance' }, { text: '👥 Invite', callback_data: 'invite' }],
        [{ text: '📋 Rules', callback_data: 'rules' }, { text: '❓ Help', callback_data: 'help' }],
    ];
    
    if (isAdmin) {
        buttons.push([{ text: '👑 Admin Panel', callback_data: 'admin_panel' }]);
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

// /start command - ✅ FIXED endpoint
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralId = match ? match[1] : null;
    
    try {
        // ✅ FIXED: Use /api/users/register (not /api/auth/register)
        await axios.post(`${API_URL}/api/users/register`, {
            telegramId: userId,
            username: msg.from.username || '',
            firstName: msg.from.first_name || '',
            lastName: msg.from.last_name || '',
        });
    } catch (error) {
        console.log('Registration error (user may already exist):', error.message);
    }
    
    const welcomeText = `
🎯 *Welcome to M-BINGO!*

Play the classic BINGO game with friends and win real prizes!

💰 *Start with 500 Birr bonus!*

📌 *How to Play:*
1️⃣ Click "Play BINGO" to open the game
2️⃣ Register with your name (first time)
3️⃣ Select your stake (10-200 Birr)
4️⃣ Choose 1-5 BINGO cards
5️⃣ Wait for other players (2+ needed)
6️⃣ Game starts automatically!
7️⃣ First to complete a pattern wins! 🏆

🎁 *Prize:* 70% of total bets go to the winner!

🔗 *Share with friends:* @M_bingo_bot
    `;
    
    bot.sendMessage(chatId, welcomeText, { 
        ...mainMenu(userId),
        parse_mode: 'Markdown'
    });
});

// /balance command - ✅ FIXED endpoint
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        // ✅ FIXED: Use /api/wallet/${userId}
        const response = await axios.get(`${API_URL}/api/wallet/${userId}`);
        const data = response.data;
        
        const message = `
💰 *Your Balance*

💵 *Balance:* ${data.balance || 0} Birr
🏆 *Total Winnings:* ${data.totalWinnings || 0} Birr
🎮 *Games Played:* ${data.gamesPlayed || 0}
🏅 *Wins:* ${data.wins || 0}

Need help? Contact @frezerabiy
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
    
    const message = `
👥 *Invite Friends & Earn!*

🎁 *Referral Bonus:*
• You get 20 Birr when your friend plays!
• Your friend starts with 20 Birr bonus!

📤 *Share Your Link:*
https://t.me/M_bingo_bot?start=ref_${userId}

🔗 *Your Referral Code:* ${userId}

Share with your friends and earn together! 🎉
    `;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /winners command - ✅ FIXED for minimal backend
bot.onText(/\/winners/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        // ✅ Use /api/game/winners (if it exists) or fallback
        const response = await axios.get(`${API_URL}/api/game/winners`).catch(() => {
            // Return empty array if endpoint doesn't exist
            return { data: [] };
        });
        const winners = response.data || [];
        
        let message = '🏆 *Recent Winners*\n\n';
        
        if (winners && winners.length > 0) {
            winners.slice(0, 10).forEach((w, i) => {
                message += `${i+1}. 👤 ${w.name || 'Player'} - ${w.prize || 0} Birr\n`;
            });
        } else {
            message += 'No winners yet. Be the first! 🎯';
        }
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Could not fetch winners.');
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
    
    bot.sendMessage(chatId, '👑 *Admin Panel*\n\nSelect an action:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 Players', callback_data: 'admin_players' }],
                [{ text: '📊 Stats', callback_data: 'admin_stats' }],
                [{ text: '💰 Add Balance', callback_data: 'admin_add_balance' }],
                [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
                [{ text: '🔙 Main Menu', callback_data: 'back_to_menu' }]
            ]
        }
    });
});

// /players command - ✅ FIXED with adminId
bot.onText(/\/players/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    try {
        // ✅ FIXED: Pass adminId as query parameter
        const response = await axios.get(`${API_URL}/api/admin/players`, {
            params: { adminId: userId }
        });
        const players = response.data;
        
        if (!players || players.length === 0) {
            bot.sendMessage(chatId, 'No players registered.');
            return;
        }
        
        let message = '👥 *Players*\n\n';
        players.slice(0, 20).forEach(p => {
            message += `• ${p.name} - 💰 ${p.balance} Birr - ${p.total_wins || 0} wins\n`;
        });
        message += `\n📊 *Total:* ${players.length} players`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error fetching players.');
    }
});

// /addbalance [telegram_id] [amount] - ✅ FIXED
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
        // ✅ FIXED: Use /api/admin/balance/add with adminId
        const response = await axios.post(`${API_URL}/api/admin/balance/add`, {
            userId: targetId,
            amount: amount,
            adminId: userId
        });
        
        bot.sendMessage(chatId, `✅ Added ${amount} Birr to player! New balance: ${response.data.newBalance} Birr`);
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error adding balance. Make sure the player exists.');
    }
});

// /removebalance [telegram_id] [amount] - ✅ FIXED
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
        // ✅ FIXED: Use /api/admin/balance/remove with adminId
        const response = await axios.post(`${API_URL}/api/admin/balance/remove`, {
            userId: targetId,
            amount: amount,
            adminId: userId
        });
        
        bot.sendMessage(chatId, `✅ Removed ${amount} Birr from player! New balance: ${response.data.newBalance} Birr`);
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error: Insufficient balance or player not found.');
    }
});

// /gamestatus - ✅ FIXED for minimal backend
bot.onText(/\/gamestatus/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    try {
        // ✅ Use /api/game/status or fallback to /health
        const response = await axios.get(`${API_URL}/api/game/status`).catch(() => {
            return axios.get(`${API_URL}/health`);
        });
        const status = response.data;
        
        const message = `
📊 *Game Status*

🏠 *Rooms:* ${status.rooms || 0}
👥 *Players:* ${status.players || 0}
🎯 *Active Games:* ${status.activeGames || 0}
🔄 *System Status:* ${status.status || 'Operational'}
📈 *Uptime:* ${status.uptime || 'N/A'}
        `;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error fetching game status.');
    }
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
            
        case 'invite':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/invite');
            break;
            
        case 'rules':
            const rulesText = `
📋 *BINGO Rules*

🎯 *Goal:* Complete a pattern on your card first!

🔢 *Numbers:* 1-75 are called randomly

🏆 *Winning Patterns:*
• Row - 5 numbers in a horizontal line
• Column - 5 numbers in a vertical line
• Diagonal - 5 numbers diagonally
• Corners - All 4 corners
• Full House - All numbers on card

💰 *Stakes:* 10, 20, 30, 50, 100, 200 Birr

🎁 *Prize Pool:* 70% of total bets

⚡ *Auto-Start:* Game begins with 2+ players

👥 *Max Players:* Unlimited!

Good luck! 🍀
            `;
            bot.editMessageText(rulesText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Back', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'help':
            const helpText = `
📖 *Help Guide*

🎯 *How to Play:*
• Click "Play BINGO" to start
• Select your bet amount
• Choose 1-5 BINGO cards
• Game starts with 2+ players
• Numbers are called automatically
• First to get BINGO wins!

💰 *Balance:*
• Start with 500 Birr
• Deposit via admin
• Withdraw your winnings

🎁 *Invite Friends:*
• Share @M_bingo_bot
• Get 20 Birr bonus

👑 *Admin Contact:*
Contact @frezerabiy for support
            `;
            bot.editMessageText(helpText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Back', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'back_to_menu':
            const menuText = '🎯 *Welcome to M-BINGO!*\n\nSelect an option:';
            bot.editMessageText(menuText, {
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
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/admin');
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
                // ✅ FIXED: Use /api/admin/stats with adminId
                const stats = await axios.get(`${API_URL}/api/admin/stats`, {
                    params: { adminId: userId }
                });
                const s = stats.data;
                bot.sendMessage(chatId, `
📊 *Server Stats*

👥 Online Players: ${s.onlinePlayers || 0}
🎮 Active Games: ${s.activeGames || 0}
💰 Today\'s Revenue: ${s.todayRevenue || 0} Birr
📈 Total Users: ${s.totalUsers || 0}
🏠 Total Rooms: ${s.totalRooms || 0}
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
            bot.sendMessage(chatId, '💰 *Add Balance*\n\nSend: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 123456789 100');
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
                [{ text: '🎯 Play BINGO', web_app: { url: GAME_URL } }],
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

console.log('✅ M-BINGO Bot is running!');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`🔗 API URL: ${API_URL}`);
console.log('👑 Admin IDs:', ADMIN_IDS);