// ============================================================
// M-BINGO TELEGRAM BOT - PRODUCTION VERSION
// @M_bingo_bot
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN || '8312462723:AAHVyOGm7vDKJD7M_8ZceQzgvwLkMGc6dEU';
const API_URL = process.env.API_URL || 'http://localhost:3000';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_IDS = (process.env.ADMIN_IDS || '555508978').split(',').map(id => parseInt(id.trim()));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('🤖 M-BINGO Bot starting...');
console.log(`📡 API URL: ${API_URL}`);
console.log(`👑 Admin IDs: ${ADMIN_IDS}`);

// ============================================================
// MAIN MENU
// ============================================================

function mainMenu(userId) {
    const isAdmin = ADMIN_IDS.includes(userId);
    const buttons = [
        [{ text: '🎯 Play BINGO', web_app: { url: GAME_URL } }],
        [{ text: '💰 Balance', callback_data: 'balance' }, { text: '📊 Stats', callback_data: 'stats' }],
        [{ text: '👥 Invite Friends', callback_data: 'invite' }, { text: '🏆 Winners', callback_data: 'winners' }],
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

// /start command
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralId = match ? match[1] : null;
    
    // Register user in database
    try {
        await axios.post(`${API_URL}/api/auth/register`, {
            telegramId: userId,
            username: msg.from.username || '',
            firstName: msg.from.first_name || '',
            lastName: msg.from.last_name || '',
            referralId: referralId
        });
    } catch (error) {
        // User might already exist, ignore
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

// /balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const response = await axios.get(`${API_URL}/api/wallet/${userId}`);
        const data = response.data;
        
        const message = `
💰 *Your Balance*

💵 *Balance:* ${data.balance || 0} Birr
🏆 *Total Winnings:* ${data.total_winnings || 0} Birr
🎮 *Games Played:* ${data.total_games_played || 0}
🏅 *Wins:* ${data.total_wins || 0}

📊 *Transaction Summary:*
📥 Total Credits: ${data.total_credits || 0} Birr
📤 Total Debits: ${data.total_debits || 0} Birr

*Need help?* Contact @frezerabiy
        `;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Could not fetch balance. Please try again later.');
    }
});

// /stats command
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const response = await axios.get(`${API_URL}/api/game/stats`);
        const stats = response.data;
        
        const message = `
📊 *M-BINGO Live Stats*

👥 *Online Players:* ${stats.onlinePlayers || 0}
🎯 *Active Games:* ${stats.activeGames || 0}
🎮 *Games Today:* ${stats.gamesToday || 0}
💰 *Today\'s Revenue:* ${stats.todayRevenue || 0} Birr
🎁 *Total Prize Paid:* ${stats.totalPrizePaid || 0} Birr

🏆 *Top Winners:*
${stats.topWinners ? stats.topWinners.map((w, i) => `${i+1}. ${w.name} - ${w.totalWins} wins (${w.totalPrize} Birr)`).join('\n') : 'No winners yet'}

📈 *7-Day Revenue:* ${stats.weeklyRevenue || 0} Birr
        `;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Could not fetch stats.');
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

// /winners command
bot.onText(/\/winners/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const response = await axios.get(`${API_URL}/api/game/winners`);
        const winners = response.data;
        
        let message = '🏆 *Recent Winners*\n\n';
        
        if (winners && winners.length > 0) {
            winners.slice(0, 10).forEach((w, i) => {
                message += `${i+1}. 👤 ${w.name} - ${w.prize} Birr (${w.gameNumber})\n`;
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
    
    const message = `
👑 *Admin Panel*

📊 *Quick Stats:*
• ${await getOnlinePlayers()} online players
• ${await getActiveGames()} active games

Select an action below:
    `;
    
    bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 Players', callback_data: 'admin_players' }],
                [{ text: '💰 Deposits', callback_data: 'admin_deposits' }],
                [{ text: '🏦 Withdrawals', callback_data: 'admin_withdrawals' }],
                [{ text: '🎮 Rooms', callback_data: 'admin_rooms' }],
                [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
                [{ text: '📊 Reports', callback_data: 'admin_reports' }],
                [{ text: '⚙️ Settings', callback_data: 'admin_settings' }],
                [{ text: '🔙 Main Menu', callback_data: 'back_to_menu' }]
            ]
        }
    });
});

// /players command - Show all players
bot.onText(/\/players/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    try {
        const response = await axios.get(`${API_URL}/api/admin/players`);
        const players = response.data;
        
        if (!players || players.length === 0) {
            bot.sendMessage(chatId, 'No players registered.');
            return;
        }
        
        let message = '👥 *Players*\n\n';
        players.forEach(p => {
            message += `• ${p.name} - 💰 ${p.balance} Birr - ${p.total_wins} wins\n`;
        });
        message += `\n📊 *Total:* ${players.length} players`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error fetching players.');
    }
});

// /addbalance [telegram_id] [amount] - Admin only
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
            telegramId: targetId,
            amount: amount,
            adminId: userId
        });
        
        bot.sendMessage(chatId, `✅ Added ${amount} Birr to player! New balance: ${response.data.newBalance} Birr`);
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error adding balance. Make sure the player exists.');
    }
});

// /removebalance [telegram_id] [amount] - Admin only
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
            telegramId: targetId,
            amount: amount,
            adminId: userId
        });
        
        bot.sendMessage(chatId, `✅ Removed ${amount} Birr from player! New balance: ${response.data.newBalance} Birr`);
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error: Insufficient balance or player not found.');
    }
});

// /broadcast [message] - Admin only
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    const message = match[1];
    
    try {
        await axios.post(`${API_URL}/api/admin/broadcast`, {
            message: message,
            adminId: userId
        });
        
        bot.sendMessage(chatId, '✅ Broadcast sent to all players!');
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error sending broadcast.');
    }
});

// /gamestatus - Check game status (admin only)
bot.onText(/\/gamestatus/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized.');
        return;
    }
    
    try {
        const response = await axios.get(`${API_URL}/api/game/status`);
        const status = response.data;
        
        const message = `
📊 *Game Status*

🏠 *Rooms:* ${status.rooms || 0}
👥 *Players:* ${status.players || 0}
🎯 *Active Games:* ${status.activeGames || 0}
⏳ *Waiting:* ${status.waiting || 0}
✅ *Ready:* ${status.ready || 0}

🔄 *System Status:* ${status.systemStatus || 'Operational'}
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
            
        case 'stats':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/stats');
            break;
            
        case 'invite':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/invite');
            break;
            
        case 'winners':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/winners');
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
            
        case 'admin_deposits':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            try {
                const depositsRes = await axios.get(`${API_URL}/api/admin/deposits/pending`);
                const deposits = depositsRes.data;
                
                if (!deposits || deposits.length === 0) {
                    bot.sendMessage(chatId, 'No pending deposits.');
                    break;
                }
                
                let message = '💰 *Pending Deposits*\n\n';
                deposits.forEach(d => {
                    message += `👤 ${d.name} - ${d.amount} Birr (${d.method})\n📋 ${d.reference || 'No ref'}\n`;
                });
                message += `\nTo approve: /approve_deposit [id]`;
                
                bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } catch (error) {
                bot.sendMessage(chatId, '⚠️ Error fetching deposits.');
            }
            break;
            
        case 'admin_withdrawals':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            try {
                const withdrawalsRes = await axios.get(`${API_URL}/api/admin/withdrawals/pending`);
                const withdrawals = withdrawalsRes.data;
                
                if (!withdrawals || withdrawals.length === 0) {
                    bot.sendMessage(chatId, 'No pending withdrawals.');
                    break;
                }
                
                let message = '🏦 *Pending Withdrawals*\n\n';
                withdrawals.forEach(w => {
                    message += `👤 ${w.name} - ${w.amount} Birr (${w.method})\n📱 ${w.destination}\n`;
                });
                message += `\nTo approve: /approve_withdrawal [id]`;
                
                bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } catch (error) {
                bot.sendMessage(chatId, '⚠️ Error fetching withdrawals.');
            }
            break;
            
        case 'admin_rooms':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            try {
                const roomsRes = await axios.get(`${API_URL}/api/rooms`);
                const rooms = roomsRes.data;
                
                if (!rooms || rooms.length === 0) {
                    bot.sendMessage(chatId, 'No active rooms.');
                    break;
                }
                
                let message = '🎮 *Active Rooms*\n\n';
                rooms.forEach(r => {
                    message += `💰 ${r.stake} Birr - ${r.playerCount} players - ${r.status}\n`;
                });
                
                bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } catch (error) {
                bot.sendMessage(chatId, '⚠️ Error fetching rooms.');
            }
            break;
            
        case 'admin_broadcast':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, '📢 *Send Broadcast*\n\nUse: /broadcast [your message]');
            break;
            
        case 'admin_reports':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            bot.sendMessage(chatId, '📊 *Reports*\n\nUse:\n/report daily - Daily report\n/report weekly - Weekly report\n/report monthly - Monthly report');
            break;
            
        case 'admin_settings':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized.');
                break;
            }
            const settingsMessage = `
⚙️ *Settings*

Configure game settings:

🎯 *Default Stake:* 10 Birr
👥 *Min Players:* 2
⏱️ *Countdown:* 30 seconds
📞 *Call Interval:* 5 seconds
🏠 *House Commission:* 30%

To change: /set [setting] [value]
            `;
            bot.sendMessage(chatId, settingsMessage, { parse_mode: 'Markdown' });
            break;
    }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function getOnlinePlayers() {
    try {
        const response = await axios.get(`${API_URL}/api/game/online`);
        return response.data.count || 0;
    } catch {
        return 0;
    }
}

async function getActiveGames() {
    try {
        const response = await axios.get(`${API_URL}/api/game/active`);
        return response.data.count || 0;
    } catch {
        return 0;
    }
}

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
