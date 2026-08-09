// ============================================================
// M-BINGO TELEGRAM BOT - PRODUCTION VERSION
// @M_bingo_bot
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();

// ============================================================
// CONFIGURATION - âœ… UPDATED
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN || '8312462723:AAHVyOGm7vDKJD7M_8ZceQzgvwLkMGc6dEU';
// âœ… USE RENDER URL (not localhost)
const API_URL = process.env.API_URL || 'https://m-bingo-server.onrender.com';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_IDS = (process.env.ADMIN_IDS || '555508978').split(',').map(id => parseInt(id.trim()));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('ðŸ¤– M-BINGO Bot starting...');
console.log(`ðŸ“¡ API URL: ${API_URL}`);
console.log(`ðŸŽ¯ Game URL: ${GAME_URL}`);
console.log(`ðŸ‘‘ Admin IDs: ${ADMIN_IDS}`);

// ============================================================
// MAIN MENU
// ============================================================

function mainMenu(userId) {
    const isAdmin = ADMIN_IDS.includes(userId);
    const buttons = [
        [{ text: 'ðŸŽ¯ Play BINGO', web_app: { url: GAME_URL } }],
        [{ text: 'ðŸ’° Balance', callback_data: 'balance' }, { text: 'ðŸ‘¥ Invite', callback_data: 'invite' }],
        [{ text: 'ðŸ“‹ Rules', callback_data: 'rules' }, { text: 'â“ Help', callback_data: 'help' }],
    ];
    
    if (isAdmin) {
        buttons.push([{ text: 'ðŸ‘‘ Admin Panel', callback_data: 'admin_panel' }]);
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

// /start command - âœ… FIXED endpoint
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralId = match ? match[1] : null;
    
    try {
        // âœ… FIXED: Use /api/users/register (not /api/auth/register)
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
ðŸŽ¯ *Welcome to M-BINGO!*

Play the classic BINGO game with friends and win real prizes!

ðŸ’° *Start with 500 Birr bonus!*

ðŸ“Œ *How to Play:*
1ï¸âƒ£ Click "Play BINGO" to open the game
2ï¸âƒ£ Register with your name (first time)
3ï¸âƒ£ Select your stake (10-200 Birr)
4ï¸âƒ£ Choose 1-5 BINGO cards
5ï¸âƒ£ Wait for other players (2+ needed)
6ï¸âƒ£ Game starts automatically!
7ï¸âƒ£ First to complete a pattern wins! ðŸ†

ðŸŽ *Prize:* 70% of total bets go to the winner!

ðŸ”— *Share with friends:* @M_bingo_bot
    `;
    
    bot.sendMessage(chatId, welcomeText, { 
        ...mainMenu(userId),
        parse_mode: 'Markdown'
    });
});

// /balance command - âœ… FIXED endpoint
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        // âœ… FIXED: Use /api/wallet/${userId}
        const response = await axios.get(`${API_URL}/api/wallet/${userId}`);
        const data = response.data;
        
        const message = `
ðŸ’° *Your Balance*

ðŸ’µ *Balance:* ${data.balance || 0} Birr
ðŸ† *Total Winnings:* ${data.totalWinnings || 0} Birr
ðŸŽ® *Games Played:* ${data.gamesPlayed || 0}
ðŸ… *Wins:* ${data.wins || 0}

Need help? Contact @frezerabiy
        `;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Could not fetch balance. Please play a game first.');
    }
});

// /invite command
bot.onText(/\/invite/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const message = `
ðŸ‘¥ *Invite Friends & Earn!*

ðŸŽ *Referral Bonus:*
â€¢ You get 20 Birr when your friend plays!
â€¢ Your friend starts with 20 Birr bonus!

ðŸ“¤ *Share Your Link:*
https://t.me/M_bingo_bot?start=ref_${userId}

ðŸ”— *Your Referral Code:* ${userId}

Share with your friends and earn together! ðŸŽ‰
    `;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /winners command - âœ… FIXED for minimal backend
bot.onText(/\/winners/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        // âœ… Use /api/game/winners (if it exists) or fallback
        const response = await axios.get(`${API_URL}/api/game/winners`).catch(() => {
            // Return empty array if endpoint doesn't exist
            return { data: [] };
        });
        const winners = response.data || [];
        
        let message = 'ðŸ† *Recent Winners*\n\n';
        
        if (winners && winners.length > 0) {
            winners.slice(0, 10).forEach((w, i) => {
                message += `${i+1}. ðŸ‘¤ ${w.name || 'Player'} - ${w.prize || 0} Birr\n`;
            });
        } else {
            message += 'No winners yet. Be the first! ðŸŽ¯';
        }
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Could not fetch winners.');
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
        bot.sendMessage(chatId, 'â›” Unauthorized. You do not have admin access.');
        return;
    }
    
    bot.sendMessage(chatId, 'ðŸ‘‘ *Admin Panel*\n\nSelect an action:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'ðŸ‘¥ Players', callback_data: 'admin_players' }],
                [{ text: 'ðŸ“Š Stats', callback_data: 'admin_stats' }],
                [{ text: 'ðŸ’° Add Balance', callback_data: 'admin_add_balance' }],
                [{ text: 'ðŸ“¢ Broadcast', callback_data: 'admin_broadcast' }],
                [{ text: 'ðŸ”™ Main Menu', callback_data: 'back_to_menu' }]
            ]
        }
    });
});

// /players command - âœ… FIXED with adminId
bot.onText(/\/players/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” Unauthorized.');
        return;
    }
    
    try {
        // âœ… FIXED: Pass adminId as query parameter
        const response = await axios.get(`${API_URL}/api/admin/players`, {
            params: { adminId: userId }
        });
        const players = response.data;
        
        if (!players || players.length === 0) {
            bot.sendMessage(chatId, 'No players registered.');
            return;
        }
        
        let message = 'ðŸ‘¥ *Players*\n\n';
        players.slice(0, 20).forEach(p => {
            message += `â€¢ ${p.name} - ðŸ’° ${p.balance} Birr - ${p.total_wins || 0} wins\n`;
        });
        message += `\nðŸ“Š *Total:* ${players.length} players`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Error fetching players.');
    }
});

// /addbalance [telegram_id] [amount] - âœ… FIXED
bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” Unauthorized.');
        return;
    }
    
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    
    try {
        // âœ… FIXED: Use /api/admin/balance/add with adminId
        const response = await axios.post(`${API_URL}/api/admin/balance/add`, {
            userId: targetId,
            amount: amount,
            adminId: userId
        });
        
        bot.sendMessage(chatId, `âœ… Added ${amount} Birr to player! New balance: ${response.data.newBalance} Birr`);
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Error adding balance. Make sure the player exists.');
    }
});

// /removebalance [telegram_id] [amount] - âœ… FIXED
bot.onText(/\/removebalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” Unauthorized.');
        return;
    }
    
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    
    try {
        // âœ… FIXED: Use /api/admin/balance/remove with adminId
        const response = await axios.post(`${API_URL}/api/admin/balance/remove`, {
            userId: targetId,
            amount: amount,
            adminId: userId
        });
        
        bot.sendMessage(chatId, `âœ… Removed ${amount} Birr from player! New balance: ${response.data.newBalance} Birr`);
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Error: Insufficient balance or player not found.');
    }
});

// /gamestatus - âœ… FIXED for minimal backend
bot.onText(/\/gamestatus/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” Unauthorized.');
        return;
    }
    
    try {
        // âœ… Use /api/game/status or fallback to /health
        const response = await axios.get(`${API_URL}/api/game/status`).catch(() => {
            return axios.get(`${API_URL}/health`);
        });
        const status = response.data;
        
        const message = `
ðŸ“Š *Game Status*

ðŸ  *Rooms:* ${status.rooms || 0}
ðŸ‘¥ *Players:* ${status.players || 0}
ðŸŽ¯ *Active Games:* ${status.activeGames || 0}
ðŸ”„ *System Status:* ${status.status || 'Operational'}
ðŸ“ˆ *Uptime:* ${status.uptime || 'N/A'}
        `;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Error fetching game status.');
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
ðŸ“‹ *BINGO Rules*

ðŸŽ¯ *Goal:* Complete a pattern on your card first!

ðŸ”¢ *Numbers:* 1-75 are called randomly

ðŸ† *Winning Patterns:*
â€¢ Row - 5 numbers in a horizontal line
â€¢ Column - 5 numbers in a vertical line
â€¢ Diagonal - 5 numbers diagonally
â€¢ Corners - All 4 corners
â€¢ Full House - All numbers on card

ðŸ’° *Stakes:* 10, 20, 30, 50, 100, 200 Birr

ðŸŽ *Prize Pool:* 70% of total bets

âš¡ *Auto-Start:* Game begins with 2+ players

ðŸ‘¥ *Max Players:* Unlimited!

Good luck! ðŸ€
            `;
            bot.editMessageText(rulesText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'ðŸ”™ Back', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'help':
            const helpText = `
ðŸ“– *Help Guide*

ðŸŽ¯ *How to Play:*
â€¢ Click "Play BINGO" to start
â€¢ Select your bet amount
â€¢ Choose 1-5 BINGO cards
â€¢ Game starts with 2+ players
â€¢ Numbers are called automatically
â€¢ First to get BINGO wins!

ðŸ’° *Balance:*
â€¢ Start with 500 Birr
â€¢ Deposit via admin
â€¢ Withdraw your winnings

ðŸŽ *Invite Friends:*
â€¢ Share @M_bingo_bot
â€¢ Get 20 Birr bonus

ðŸ‘‘ *Admin Contact:*
Contact @frezerabiy for support
            `;
            bot.editMessageText(helpText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'ðŸ”™ Back', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'back_to_menu':
            const menuText = 'ðŸŽ¯ *Welcome to M-BINGO!*\n\nSelect an option:';
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
                bot.sendMessage(chatId, 'â›” Unauthorized.');
                break;
            }
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/admin');
            break;
            
        case 'admin_players':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized.');
                break;
            }
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/players');
            break;
            
        case 'admin_stats':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized.');
                break;
            }
            try {
                // âœ… FIXED: Use /api/admin/stats with adminId
                const stats = await axios.get(`${API_URL}/api/admin/stats`, {
                    params: { adminId: userId }
                });
                const s = stats.data;
                bot.sendMessage(chatId, `
ðŸ“Š *Server Stats*

ðŸ‘¥ Online Players: ${s.onlinePlayers || 0}
ðŸŽ® Active Games: ${s.activeGames || 0}
ðŸ’° Today\'s Revenue: ${s.todayRevenue || 0} Birr
ðŸ“ˆ Total Users: ${s.totalUsers || 0}
ðŸ  Total Rooms: ${s.totalRooms || 0}
                `, { parse_mode: 'Markdown' });
            } catch (error) {
                bot.sendMessage(chatId, 'âš ï¸ Error fetching stats.');
            }
            break;
            
        case 'admin_add_balance':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, 'ðŸ’° *Add Balance*\n\nSend: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 123456789 100');
            break;
            
        case 'admin_broadcast':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, 'ðŸ“¢ *Send Broadcast*\n\nUse: /broadcast [your message]');
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
        title: 'ðŸŽ¯ Play BINGO with friends!',
        description: 'Join @M_bingo_bot and win real prizes!',
        input_message_content: {
            message_text: "ðŸŽ¯ Join me on M-BINGO!\n\nPlay with friends and win real prizes!\nðŸ‘‰ @M_bingo_bot"
        },
        reply_markup: {
            inline_keyboard: [
                [{ text: 'ðŸŽ¯ Play BINGO', web_app: { url: GAME_URL } }],
                [{ text: 'ðŸ’° Get Started', url: 'https://t.me/M_bingo_bot' }]
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

console.log('âœ… M-BINGO Bot is running!');
console.log(`ðŸ“ Game URL: ${GAME_URL}`);
console.log(`ðŸ”— API URL: ${API_URL}`);
console.log('ðŸ‘‘ Admin IDs:', ADMIN_IDS);
