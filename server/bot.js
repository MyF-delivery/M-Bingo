// ============================================================
//  TELEGRAM BOT - @M_bingo_bot
//  Updated with Game Control Commands & Shared Multiplayer
//  ADMIN ID: 555508978
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ⚠️ REPLACE WITH YOUR NEW TOKEN (after revoking the old one)
const BOT_TOKEN = '8312462723:AAHVyOGm7vDKJD7M_8ZceQzgvwLkMGc6dEU';
const GAME_URL = 'https://myf-delivery.github.io/M-Bingo/';
const SERVER_URL = 'https://m-bingo-server.onrender.com';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ============================================================
//  ADMIN CONFIGURATION
// ============================================================

// ✅ UPDATED WITH YOUR TELEGRAM ID
const ADMIN_IDS = [555508978]; // ← YOUR ID IS NOW SET!

// ============================================================
//  MAIN MENU
// ============================================================

function mainMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎯 Play BINGO', web_app: { url: GAME_URL } }],
                [{ text: '📋 Rules', callback_data: 'rules' }, { text: '💰 Balance', callback_data: 'balance' }],
                [{ text: '👥 Friends', callback_data: 'friends' }, { text: '🏆 Winners', callback_data: 'winners' }],
                [{ text: '📊 Game Status', callback_data: 'game_status' }],
                [{ text: '❓ Help', callback_data: 'help' }],
                [{ text: '👑 Admin', callback_data: 'admin_login' }]
            ]
        }
    };
}

// ============================================================
//  COMMAND HANDLERS
// ============================================================

// /start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Check for referral code
    let referralMessage = '';
    if (text && text.includes('ref_')) {
        const refCode = text.split('ref_')[1];
        referralMessage = `\n\n🎁 You were invited by a friend! You get 20 ብር bonus!`;
        // TODO: Add bonus logic
    }
    
    const welcomeText = `
🎯 *Welcome to M BINGO!*

Play the classic BINGO game with friends and win real prizes!

*How to Play:*
1️⃣ Click "Play BINGO" to open the game
2️⃣ Register with your name
3️⃣ Select your stake (10-200 ብር)
4️⃣ Choose 1-5 cards
5️⃣ Wait for other players
6️⃣ Game starts automatically with 2+ players!
7️⃣ First to complete a pattern wins! 🏆

*Prizes:* 70% of total bets go to the winner!

🔗 *Share with friends:* @M_bingo_bot${referralMessage}
    `;
    
    bot.sendMessage(chatId, welcomeText, { 
        ...mainMenu(),
        parse_mode: 'Markdown'
    });
});

// /help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `
📖 *BINGO Help Guide*

🎯 *How to Play:*
• Click "Play BINGO" to start
• Select your bet amount
• Choose 1-5 BINGO cards
• Game starts with 2+ players
• Numbers are called automatically
• First to get BINGO wins!

💰 *Balance:*
• Start with 500 ብር
• Deposit via admin
• Withdraw your winnings

🎁 *Invite Friends:*
• Share @M_bingo_bot
• Get 20 ብር bonus when friends join!

👑 *Admin Contact:*
Contact @YOUR_USERNAME for support
    `;
    bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

// /balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const response = await axios.get(`${SERVER_URL}/api/balance/${userId}`);
        if (response.status === 200) {
            const data = response.data;
            bot.sendMessage(
                chatId,
                `💰 *Your Balance:* ${data.balance} ብር\n\n` +
                `📊 *Games Played:* ${data.games || 0}\n` +
                `🏆 *Wins:* ${data.wins || 0}`,
                { parse_mode: 'Markdown' }
            );
        } else {
            bot.sendMessage(chatId, '⚠️ Could not fetch balance. Please play a game first.');
        }
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Server connection error. Please try again later.');
    }
});

// ============================================================
//  GAME CONTROL COMMANDS (Admin Only)
// ============================================================

// /gamestatus - Check current game status (anyone can use)
bot.onText(/\/gamestatus/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const response = await axios.get(`${SERVER_URL}/api/game-state`);
        const state = response.data;
        
        let statusText = `📊 *Game Status*\n\n`;
        statusText += `Status: ${state.status || 'waiting'}\n`;
        statusText += `Players: ${state.players || 0}\n`;
        statusText += `Cards Selected: ${state.selectedCards?.length || 0}\n`;
        statusText += `Selection Time: ${state.selectionTimeLeft || 0}s\n`;
        statusText += `Numbers Called: ${state.calledNumbers?.length || 0}/75\n`;
        
        if (state.players && state.players > 0) {
            statusText += `\n👥 *Players with cards:*\n`;
            const playersRes = await axios.get(`${SERVER_URL}/api/players`);
            if (playersRes.status === 200) {
                playersRes.data.forEach(p => {
                    if (p.cards > 0) {
                        statusText += `• ${p.name} - ${p.cards} cards ${p.isReady ? '✅' : '⏳'}\n`;
                    }
                });
            }
        }
        
        bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error fetching game status');
    }
});

// /startgame - Force start the game (admin only)
bot.onText(/\/startgame/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // ✅ UPDATED: Check against YOUR ID
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ You are not authorized to use this command.');
        return;
    }
    
    try {
        const response = await axios.post(`${SERVER_URL}/api/force-start`, {});
        if (response.status === 200) {
            bot.sendMessage(chatId, '✅ Game started successfully! All players with cards are now playing.');
        } else {
            bot.sendMessage(chatId, '⚠️ Could not start game. Make sure at least 2 players have cards.');
        }
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error starting game. Need at least 2 players with cards.');
    }
});

// /players - Show all players and their cards (admin only)
bot.onText(/\/players/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // ✅ UPDATED: Check against YOUR ID
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ You are not authorized to use this command.');
        return;
    }
    
    try {
        const response = await axios.get(`${SERVER_URL}/api/players`);
        const players = response.data;
        
        if (!players || players.length === 0) {
            bot.sendMessage(chatId, 'No players connected.');
            return;
        }
        
        let text = '👥 *Players*\n\n';
        players.forEach(p => {
            text += `• ${p.name || 'Player'} - 💰 ${p.balance} ብር - 🎴 ${p.cards || 0} cards ${p.isReady ? '✅ Ready' : '⏳ Waiting'}\n`;
        });
        
        const totalCards = players.reduce((sum, p) => sum + (p.cards || 0), 0);
        text += `\n📊 *Total:* ${players.length} players, ${totalCards} cards selected`;
        
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error fetching players');
    }
});

// /addbalance [telegram_id] [amount] - Admin only
bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // ✅ UPDATED: Check against YOUR ID
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized');
        return;
    }
    
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    
    try {
        const response = await axios.post(`${SERVER_URL}/api/add-balance`, {
            telegramId: targetId,
            amount: amount
        });
        
        if (response.status === 200) {
            bot.sendMessage(chatId, `✅ Added ${amount} ብር to player! New balance: ${response.data.newBalance} ብር`);
        } else {
            bot.sendMessage(chatId, '⚠️ Could not add balance.');
        }
    } catch (error) {
        bot.sendMessage(chatId, '⚠️ Error: Player not found or server error.');
    }
});

// /withdraw [telegram_id] [amount] - Admin only
bot.onText(/\/withdraw (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // ✅ UPDATED: Check against YOUR ID
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ Unauthorized');
        return;
    }
    
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    
    try {
        const response = await axios.post(`${SERVER_URL}/api/remove-balance`, {
            telegramId: targetId,
            amount: amount
        });
        
        if (response.status === 200) {
            bot.sendMessage(chatId, `✅ Removed ${amount} ብር from player! New balance: ${response.data.newBalance} ብር`);
        } else {
            bot.sendMessage(chatId, '⚠️ Could not remove balance.');
        }
    } catch (error) {
        if (error.response && error.response.status === 400) {
            bot.sendMessage(chatId, '⚠️ Insufficient balance.');
        } else {
            bot.sendMessage(chatId, '⚠️ Error: Player not found or server error.');
        }
    }
});

// /admin - Admin panel
bot.onText(/\/admin/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // ✅ UPDATED: Check against YOUR ID
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ You are not authorized to use this command.');
        return;
    }
    
    bot.sendMessage(chatId, '👑 *Admin Panel*\n\nSelect an action:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 View Players', callback_data: 'admin_players' }],
                [{ text: '💰 Add Balance', callback_data: 'admin_add' }],
                [{ text: '🏦 Withdraw', callback_data: 'admin_withdraw' }],
                [{ text: '📊 Game Status', callback_data: 'game_status' }],
                [{ text: '▶️ Start Game', callback_data: 'admin_start_game' }],
                [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
            ]
        }
    });
});

// ============================================================
//  CALLBACK QUERY HANDLERS
// ============================================================

bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const messageId = call.message.message_id;
    const data = call.data;
    const userId = call.from.id;
    
    // Acknowledge the callback
    bot.answerCallbackQuery(call.id);
    
    switch (data) {
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

💰 *Stakes:* 10, 20, 30, 50, 100, 200 ብር

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
                        [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'balance':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance');
            break;
            
        case 'friends':
            const friendsText = `
👥 *Invite Friends!*

Share this bot with your friends:
📍 @M_bingo_bot

🎁 *Invite Bonus:*
• You get 20 ብር when your friend plays!
• Your friend starts with 20 ብር bonus!

📤 *Share Link:*
https://t.me/M_bingo_bot?start=ref_${userId}

🔗 *Referral Code:* ${userId}
            `;
            bot.editMessageText(friendsText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'winners':
            try {
                const response = await axios.get(`${SERVER_URL}/api/recent-winners`);
                let winnersText = '🏆 *Recent Winners:*\n\n';
                if (response.status === 200 && response.data && response.data.length > 0) {
                    response.data.slice(-5).forEach(w => {
                        winnersText += `👤 ${w.name || 'Player'} - ${w.prize || 0} ብር\n`;
                    });
                } else {
                    winnersText += 'No winners yet. Be the first!';
                }
                bot.editMessageText(winnersText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
            } catch (error) {
                bot.editMessageText('⚠️ Could not fetch winners.', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
            }
            break;
            
        case 'game_status':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/gamestatus');
            break;
            
        case 'help':
            bot.emit('text', { chat: { id: chatId } }, '/help');
            break;
            
        case 'admin_login':
            bot.sendMessage(chatId, '👑 *Admin Panel*\n\nUse /admin command if you have access.');
            break;
            
        case 'back_to_menu':
            const menuText = '🎯 *Welcome to M BINGO!*\n\nSelect an option:';
            bot.editMessageText(menuText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                ...mainMenu()
            });
            break;
            
        // ============================================================
        //  ADMIN CALLBACKS
        // ============================================================
            
        case 'admin_players':
            // ✅ UPDATED: Check against YOUR ID
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized');
                break;
            }
            try {
                const playersRes = await axios.get(`${SERVER_URL}/api/players`);
                let text = '👥 *Connected Players:*\n\n';
                if (playersRes.status === 200 && playersRes.data && playersRes.data.length > 0) {
                    playersRes.data.forEach(p => {
                        text += `• ${p.name || 'Player'} - 💰 ${p.balance} ብር (${p.cards || 0} cards) ${p.isReady ? '✅' : '⏳'}\n`;
                    });
                } else {
                    text += 'No players connected.';
                }
                bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Back to Admin', callback_data: 'admin_back' }]
                        ]
                    }
                });
            } catch (error) {
                bot.sendMessage(chatId, '⚠️ Error fetching players');
            }
            break;
            
        case 'admin_add':
            // ✅ UPDATED: Check against YOUR ID
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized');
                break;
            }
            bot.sendMessage(chatId, '💰 *Add Balance*\n\nSend: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 123456789 100');
            break;
            
        case 'admin_withdraw':
            // ✅ UPDATED: Check against YOUR ID
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized');
                break;
            }
            bot.sendMessage(chatId, '🏦 *Withdraw*\n\nSend: /withdraw [telegram_id] [amount]\n\nExample: /withdraw 123456789 50');
            break;
            
        case 'admin_start_game':
            // ✅ UPDATED: Check against YOUR ID
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized');
                break;
            }
            try {
                await axios.post(`${SERVER_URL}/api/force-start`, {});
                bot.sendMessage(chatId, '✅ Game started successfully!');
            } catch (error) {
                bot.sendMessage(chatId, '⚠️ Could not start game. Need at least 2 players with cards.');
            }
            break;
            
        case 'admin_back':
            // ✅ UPDATED: Check against YOUR ID
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, '⛔ Unauthorized');
                break;
            }
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/admin');
            break;
    }
});

// ============================================================
//  INLINE QUERY (for sharing)
// ============================================================

bot.on('inline_query', (query) => {
    const results = [{
        type: 'article',
        id: '1',
        title: '🎯 Play BINGO with friends!',
        description: 'Join @M_bingo_bot and win prizes!',
        thumb_url: 'https://myf-delivery.github.io/M-Bingo/icon.png',
        input_message_content: {
            message_text: "🎯 Join me on BINGO!\n\nPlay with friends and win prizes!\n👉 @M_bingo_bot"
        },
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎯 Play BINGO', web_app: { url: GAME_URL } }]
            ]
        }
    }];
    bot.answerInlineQuery(query.id, results);
});

// ============================================================
//  FALLBACK HANDLER
// ============================================================

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Ignore commands (they're handled above)
    if (text && text.startsWith('/')) return;
    
    bot.sendMessage(
        chatId,
        '❓ I don\'t understand that.\n\nUse /start to see the menu.',
        mainMenu()
    );
});

// ============================================================
//  START THE BOT
// ============================================================

console.log('🤖 M BINGO Bot is running...');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`🔗 Server: ${SERVER_URL}`);
console.log('👑 Admin ID:', ADMIN_IDS);
console.log('Press Ctrl+C to stop');