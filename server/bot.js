// ============================================================
//  TELEGRAM BOT - @M_bingo_bot
//  Updated with Game Control Commands & Shared Multiplayer
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// âš ï¸ REPLACE WITH YOUR NEW TOKEN (after revoking the old one)
const BOT_TOKEN = '8312462723:AAHVyOGm7vDKJD7M_8ZceQzgvwLkMGc6dEU';
const GAME_URL = 'https://myf-delivery.github.io/M-Bingo/';
const SERVER_URL = 'https://m-bingo-server.onrender.com';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ============================================================
//  ADMIN CONFIGURATION
// ============================================================

// âš ï¸ REPLACE WITH YOUR TELEGRAM USER ID
// Get your ID from: @userinfobot
const ADMIN_IDS = [123456789]; // â† PUT YOUR TELEGRAM ID HERE

// ============================================================
//  MAIN MENU
// ============================================================

function mainMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'ðŸŽ¯ Play BINGO', web_app: { url: GAME_URL } }],
                [{ text: 'ðŸ“‹ Rules', callback_data: 'rules' }, { text: 'ðŸ’° Balance', callback_data: 'balance' }],
                [{ text: 'ðŸ‘¥ Friends', callback_data: 'friends' }, { text: 'ðŸ† Winners', callback_data: 'winners' }],
                [{ text: 'ðŸ“Š Game Status', callback_data: 'game_status' }],
                [{ text: 'â“ Help', callback_data: 'help' }],
                [{ text: 'ðŸ‘‘ Admin', callback_data: 'admin_login' }]
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
        referralMessage = `\n\nðŸŽ You were invited by a friend! You get 20 á‰¥áˆ­ bonus!`;
        // TODO: Add bonus logic
    }
    
    const welcomeText = `
ðŸŽ¯ *Welcome to M BINGO!*

Play the classic BINGO game with friends and win real prizes!

*How to Play:*
1ï¸âƒ£ Click "Play BINGO" to open the game
2ï¸âƒ£ Register with your name
3ï¸âƒ£ Select your stake (10-200 á‰¥áˆ­)
4ï¸âƒ£ Choose 1-5 cards
5ï¸âƒ£ Wait for other players
6ï¸âƒ£ Game starts automatically with 2+ players!
7ï¸âƒ£ First to complete a pattern wins! ðŸ†

*Prizes:* 70% of total bets go to the winner!

ðŸ”— *Share with friends:* @M_bingo_bot${referralMessage}
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
ðŸ“– *BINGO Help Guide*

ðŸŽ¯ *How to Play:*
â€¢ Click "Play BINGO" to start
â€¢ Select your bet amount
â€¢ Choose 1-5 BINGO cards
â€¢ Game starts with 2+ players
â€¢ Numbers are called automatically
â€¢ First to get BINGO wins!

ðŸ’° *Balance:*
â€¢ Start with 500 á‰¥áˆ­
â€¢ Deposit via admin
â€¢ Withdraw your winnings

ðŸŽ *Invite Friends:*
â€¢ Share @M_bingo_bot
â€¢ Get 20 á‰¥áˆ­ bonus when friends join!

ðŸ‘‘ *Admin Contact:*
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
                `ðŸ’° *Your Balance:* ${data.balance} á‰¥áˆ­\n\n` +
                `ðŸ“Š *Games Played:* ${data.games || 0}\n` +
                `ðŸ† *Wins:* ${data.wins || 0}`,
                { parse_mode: 'Markdown' }
            );
        } else {
            bot.sendMessage(chatId, 'âš ï¸ Could not fetch balance. Please play a game first.');
        }
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Server connection error. Please try again later.');
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
        
        let statusText = `ðŸ“Š *Game Status*\n\n`;
        statusText += `Status: ${state.status || 'waiting'}\n`;
        statusText += `Players: ${state.players || 0}\n`;
        statusText += `Cards Selected: ${state.selectedCards?.length || 0}\n`;
        statusText += `Selection Time: ${state.selectionTimeLeft || 0}s\n`;
        statusText += `Numbers Called: ${state.calledNumbers?.length || 0}/75\n`;
        
        if (state.players && state.players > 0) {
            statusText += `\nðŸ‘¥ *Players with cards:*\n`;
            // Get player details
            const playersRes = await axios.get(`${SERVER_URL}/api/players`);
            if (playersRes.status === 200) {
                playersRes.data.forEach(p => {
                    if (p.cards > 0) {
                        statusText += `â€¢ ${p.name} - ${p.cards} cards ${p.isReady ? 'âœ…' : 'â³'}\n`;
                    }
                });
            }
        }
        
        bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Error fetching game status');
    }
});

// /startgame - Force start the game (admin only)
bot.onText(/\/startgame/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” You are not authorized to use this command.');
        return;
    }
    
    try {
        // Send request to server to force start
        const response = await axios.post(`${SERVER_URL}/api/force-start`, {});
        if (response.status === 200) {
            bot.sendMessage(chatId, 'âœ… Game started successfully! All players with cards are now playing.');
        } else {
            bot.sendMessage(chatId, 'âš ï¸ Could not start game. Make sure at least 2 players have cards.');
        }
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Error starting game. Need at least 2 players with cards.');
    }
});

// /players - Show all players and their cards (admin only)
bot.onText(/\/players/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” You are not authorized to use this command.');
        return;
    }
    
    try {
        const response = await axios.get(`${SERVER_URL}/api/players`);
        const players = response.data;
        
        if (!players || players.length === 0) {
            bot.sendMessage(chatId, 'No players connected.');
            return;
        }
        
        let text = 'ðŸ‘¥ *Players*\n\n';
        players.forEach(p => {
            text += `â€¢ ${p.name || 'Player'} - ðŸ’° ${p.balance} á‰¥áˆ­ - ðŸŽ´ ${p.cards || 0} cards ${p.isReady ? 'âœ… Ready' : 'â³ Waiting'}\n`;
        });
        
        // Show total
        const totalCards = players.reduce((sum, p) => sum + (p.cards || 0), 0);
        text += `\nðŸ“Š *Total:* ${players.length} players, ${totalCards} cards selected`;
        
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Error fetching players');
    }
});

// /addbalance [telegram_id] [amount] - Admin only
bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” Unauthorized');
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
            bot.sendMessage(chatId, `âœ… Added ${amount} á‰¥áˆ­ to player! New balance: ${response.data.newBalance} á‰¥áˆ­`);
        } else {
            bot.sendMessage(chatId, 'âš ï¸ Could not add balance.');
        }
    } catch (error) {
        bot.sendMessage(chatId, 'âš ï¸ Error: Player not found or server error.');
    }
});

// /withdraw [telegram_id] [amount] - Admin only
bot.onText(/\/withdraw (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” Unauthorized');
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
            bot.sendMessage(chatId, `âœ… Removed ${amount} á‰¥áˆ­ from player! New balance: ${response.data.newBalance} á‰¥áˆ­`);
        } else {
            bot.sendMessage(chatId, 'âš ï¸ Could not remove balance.');
        }
    } catch (error) {
        if (error.response && error.response.status === 400) {
            bot.sendMessage(chatId, 'âš ï¸ Insufficient balance.');
        } else {
            bot.sendMessage(chatId, 'âš ï¸ Error: Player not found or server error.');
        }
    }
});

// /admin - Admin panel
bot.onText(/\/admin/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, 'â›” You are not authorized to use this command.');
        return;
    }
    
    bot.sendMessage(chatId, 'ðŸ‘‘ *Admin Panel*\n\nSelect an action:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'ðŸ‘¥ View Players', callback_data: 'admin_players' }],
                [{ text: 'ðŸ’° Add Balance', callback_data: 'admin_add' }],
                [{ text: 'ðŸ¦ Withdraw', callback_data: 'admin_withdraw' }],
                [{ text: 'ðŸ“Š Game Status', callback_data: 'game_status' }],
                [{ text: 'â–¶ï¸ Start Game', callback_data: 'admin_start_game' }],
                [{ text: 'ðŸ”™ Back to Menu', callback_data: 'back_to_menu' }]
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
ðŸ“‹ *BINGO Rules*

ðŸŽ¯ *Goal:* Complete a pattern on your card first!

ðŸ”¢ *Numbers:* 1-75 are called randomly

ðŸ† *Winning Patterns:*
â€¢ Row - 5 numbers in a horizontal line
â€¢ Column - 5 numbers in a vertical line
â€¢ Diagonal - 5 numbers diagonally
â€¢ Corners - All 4 corners

ðŸ’° *Stakes:* 10, 20, 30, 50, 100, 200 á‰¥áˆ­

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
                        [{ text: 'ðŸ”™ Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'balance':
            bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance');
            break;
            
        case 'friends':
            const friendsText = `
ðŸ‘¥ *Invite Friends!*

Share this bot with your friends:
ðŸ“ @M_bingo_bot

ðŸŽ *Invite Bonus:*
â€¢ You get 20 á‰¥áˆ­ when your friend plays!
â€¢ Your friend starts with 20 á‰¥áˆ­ bonus!

ðŸ“¤ *Share Link:*
https://t.me/M_bingo_bot?start=ref_${userId}

ðŸ”— *Referral Code:* ${userId}
            `;
            bot.editMessageText(friendsText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'ðŸ”™ Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
            
        case 'winners':
            try {
                const response = await axios.get(`${SERVER_URL}/api/recent-winners`);
                let winnersText = 'ðŸ† *Recent Winners:*\n\n';
                if (response.status === 200 && response.data && response.data.length > 0) {
                    response.data.slice(-5).forEach(w => {
                        winnersText += `ðŸ‘¤ ${w.name || 'Player'} - ${w.prize || 0} á‰¥áˆ­\n`;
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
                            [{ text: 'ðŸ”™ Back to Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
            } catch (error) {
                bot.editMessageText('âš ï¸ Could not fetch winners.', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'ðŸ”™ Back to Menu', callback_data: 'back_to_menu' }]
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
            bot.sendMessage(chatId, 'ðŸ‘‘ *Admin Panel*\n\nUse /admin command if you have access.');
            break;
            
        case 'back_to_menu':
            const menuText = 'ðŸŽ¯ *Welcome to M BINGO!*\n\nSelect an option:';
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
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized');
                break;
            }
            try {
                const playersRes = await axios.get(`${SERVER_URL}/api/players`);
                let text = 'ðŸ‘¥ *Connected Players:*\n\n';
                if (playersRes.status === 200 && playersRes.data && playersRes.data.length > 0) {
                    playersRes.data.forEach(p => {
                        text += `â€¢ ${p.name || 'Player'} - ðŸ’° ${p.balance} á‰¥áˆ­ (${p.cards || 0} cards) ${p.isReady ? 'âœ…' : 'â³'}\n`;
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
                            [{ text: 'ðŸ”™ Back to Admin', callback_data: 'admin_back' }]
                        ]
                    }
                });
            } catch (error) {
                bot.sendMessage(chatId, 'âš ï¸ Error fetching players');
            }
            break;
            
        case 'admin_add':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized');
                break;
            }
            bot.sendMessage(chatId, 'ðŸ’° *Add Balance*\n\nSend: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 123456789 100');
            break;
            
        case 'admin_withdraw':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized');
                break;
            }
            bot.sendMessage(chatId, 'ðŸ¦ *Withdraw*\n\nSend: /withdraw [telegram_id] [amount]\n\nExample: /withdraw 123456789 50');
            break;
            
        case 'admin_start_game':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized');
                break;
            }
            try {
                await axios.post(`${SERVER_URL}/api/force-start`, {});
                bot.sendMessage(chatId, 'âœ… Game started successfully!');
            } catch (error) {
                bot.sendMessage(chatId, 'âš ï¸ Could not start game. Need at least 2 players with cards.');
            }
            break;
            
        case 'admin_back':
            if (!ADMIN_IDS.includes(userId)) {
                bot.sendMessage(chatId, 'â›” Unauthorized');
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
        title: 'ðŸŽ¯ Play BINGO with friends!',
        description: 'Join @M_bingo_bot and win prizes!',
        thumb_url: 'https://myf-delivery.github.io/M-Bingo/icon.png',
        input_message_content: {
            message_text: "ðŸŽ¯ Join me on BINGO!\n\nPlay with friends and win prizes!\nðŸ‘‰ @M_bingo_bot"
        },
        reply_markup: {
            inline_keyboard: [
                [{ text: 'ðŸŽ¯ Play BINGO', web_app: { url: GAME_URL } }]
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
        'â“ I don\'t understand that.\n\nUse /start to see the menu.',
        mainMenu()
    );
});

// ============================================================
//  START THE BOT
// ============================================================

console.log('ðŸ¤– M BINGO Bot is running...');
console.log(`ðŸ“ Game URL: ${GAME_URL}`);
console.log(`ðŸ”— Server: ${SERVER_URL}`);
console.log('ðŸ“Š Admin IDs:', ADMIN_IDS);
console.log('Press Ctrl+C to stop');
