// ============================================================
//  TELEGRAM BOT - @M_bingo_bot
//  Matches Cartela BINGO structure
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ⚠️ REPLACE WITH YOUR NEW TOKEN (after revoking the old one)
const BOT_TOKEN = 'YOUR_NEW_BOT_TOKEN';
const GAME_URL = 'https://myf-delivery.github.io/M-Bingo/';
const SERVER_URL = 'https://m-bingo-server.onrender.com';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

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
    if (text.includes('ref_')) {
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
//  CALLBACK QUERY HANDLERS
// ============================================================

bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const messageId = call.message.message_id;
    const data = call.data;
    
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
            // Trigger the balance command
            bot.emit('text', { chat: { id: chatId }, from: { id: call.from.id } }, '/balance');
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
https://t.me/M_bingo_bot?start=ref_${call.from.id}

🔗 *Referral Code:* ${call.from.id}
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
                if (response.status === 200 && response.data.length > 0) {
                    response.data.slice(-5).forEach(w => {
                        winnersText += `👤 ${w.name} - ${w.prize} ብር\n`;
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
            
        case 'help':
            bot.emit('text', { chat: { id: chatId } }, '/help');
            break;
            
        case 'admin_login':
            bot.sendMessage(chatId, '👑 *Admin Panel*\n\nEnter admin password:');
            // In production, implement proper password handling
            bot.sendMessage(chatId, 'Use /admin command if you have access.');
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
    }
});

// ============================================================
//  ADMIN COMMAND (Hidden)
// ============================================================

// Allow only specific Telegram IDs (replace with yours)
const ADMIN_IDS = [123456789]; // Replace with your Telegram ID

bot.onText(/\/admin/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
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
                [{ text: '📊 Stats', callback_data: 'admin_stats' }],
                [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
            ]
        }
    });
});

// Handle admin callbacks
bot.on('callback_query', async (call) => {
    // ... existing code ...
    
    if (call.data.startsWith('admin_')) {
        const chatId = call.message.chat.id;
        const userId = call.from.id;
        
        if (!ADMIN_IDS.includes(userId)) {
            bot.answerCallbackQuery(call.id, '⛔ Unauthorized');
            return;
        }
        
        switch (call.data) {
            case 'admin_players':
                try {
                    const response = await axios.get(`${SERVER_URL}/api/players`);
                    let text = '👥 *Connected Players:*\n\n';
                    if (response.status === 200 && response.data.length > 0) {
                        response.data.forEach(p => {
                            text += `• ${p.name} - 💰 ${p.balance} ብር (${p.cards || 0} cards)\n`;
                        });
                    } else {
                        text += 'No players connected.';
                    }
                    bot.answerCallbackQuery(call.id);
                    bot.editMessageText(text, {
                        chat_id: chatId,
                        message_id: call.message.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔙 Back to Admin', callback_data: 'admin_back' }]
                            ]
                        }
                    });
                } catch (error) {
                    bot.answerCallbackQuery(call.id, '⚠️ Error fetching players');
                }
                break;
                
            case 'admin_add':
                bot.answerCallbackQuery(call.id, 'Send /addbalance [player_id] [amount]');
                break;
                
            case 'admin_withdraw':
                bot.answerCallbackQuery(call.id, 'Send /withdraw [player_id] [amount]');
                break;
                
            case 'admin_stats':
                bot.answerCallbackQuery(call.id, `📊 Total players: ${players.length || 0}`);
                break;
                
            case 'admin_back':
                bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/admin');
                break;
        }
    }
});

// ============================================================
//  INLINE QUERY (for sharing)
// ============================================================

bot.on('inline_query', (query) => {
    const results = [{
        type: 'article',
        id: '1',
        title: 'Play BINGO with friends!',
        description: 'Join @M_bingo_bot and win prizes!',
        input_message_content: {
            message_text: "🎯 Join me on BINGO!\n\nPlay with friends and win prizes!\n👉 @M_bingo_bot"
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
    
    if (text && !text.startsWith('/')) {
        bot.sendMessage(
            chatId,
            '❓ I don\'t understand that command.\n\nUse /start to see the menu.',
            mainMenu()
        );
    }
});

// ============================================================
//  START BOT
// ============================================================

console.log('🤖 BINGO Bot is running...');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`🔗 Server: ${SERVER_URL}`);
console.log('Press Ctrl+C to stop');