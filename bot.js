// bot.js
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const config = require('./config/env');
const notification = require('./services/notification');

const BOT_TOKEN = config.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required!'); process.exit(1); }

const API_URL = config.API_URL;
const GAME_URL = config.GAME_URL;
const ADMIN_TELEGRAM_ID = config.ADMIN_TELEGRAM_ID;
const ADMIN_USERNAME = config.ADMIN_USERNAME;
const ADMIN_PASSWORD = config.ADMIN_PASSWORD;
const REFERRAL_BONUS = config.REFERRAL_BONUS;

// Database is handled by the notification service (which uses db/index.js)
// No need to create a separate pool here.

const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });

// User state for multi-step flows (admin login only)
const adminLoginState = {};

// ---------- Helpers ----------
async function getOrCreateUser(telegramId, firstName, lastName, username, referralCode) {
  try {
    const response = await axios.post(`${API_URL}/api/users/register`, {
      telegramId,
      username: username || `user_${telegramId}`,
      firstName,
      lastName: lastName || '',
      referralCode: referralCode || null
    }, { headers: { 'x-bot-token': BOT_TOKEN } });
    return response.data.user;
  } catch (error) {
    console.error('Registration error:', error.response?.data?.message || error.message);
    return null;
  }
}

async function getUserBalance(telegramId) {
  try {
    const response = await axios.get(`${API_URL}/api/wallet/${telegramId}`);
    return response.data.balance || 0;
  } catch (error) { return 0; }
}

function formatCurrency(amount) {
  return amount.toLocaleString('en-US') + ' Birr';
}

function mainMenu(userId) {
  const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
  const buttons = [
    [{ text: "🎮 Play Game", callback_data: 'play' }],
    [{ text: "💰 Balance", callback_data: 'balance' }, { text: "🏦 Deposit", callback_data: 'deposit' }],
    [{ text: "📤 Withdraw", callback_data: 'withdraw' }, { text: "🔄 Transfer", callback_data: 'transfer' }],
    [{ text: "🎁 Invite", callback_data: 'bonus' }, { text: "📖 Help", callback_data: 'help' }],
    [{ text: "📞 Support", callback_data: 'support' }, { text: "👤 Profile", callback_data: 'profile' }]
  ];
  if (isAdmin) buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
  return { reply_markup: { inline_keyboard: buttons } };
}

async function ensureRegistered(telegramId, firstName, lastName, username) {
  try {
    const r = await axios.get(`${API_URL}/api/users/${telegramId}`);
    if (r.data.user) return true;
  } catch (e) {}
  const user = await getOrCreateUser(telegramId, firstName, lastName, username, null);
  return !!user;
}

// ---------- Commands ----------
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'Player';
  const lastName = msg.from.last_name || '';
  const username = msg.from.username || `user_${userId}`;
  const referralId = match ? parseInt(match[1]) : null;

  const isRegistered = await ensureRegistered(userId, firstName, lastName, username);

  if (isRegistered) {
    if (referralId && referralId !== userId) {
      try {
        await axios.post(`${API_URL}/api/referral/process`, { referrerId: referralId, newUserId: userId });
        await bot.sendMessage(referralId, `🎉 You earned ${REFERRAL_BONUS} Birr bonus!`);
      } catch (e) {}
    }
    const balance = await getUserBalance(userId);
    await bot.sendMessage(chatId, `👋 *Welcome back, ${firstName}!*\n\n💰 *Balance:* ${formatCurrency(balance)}`, {
      parse_mode: 'Markdown', ...mainMenu(userId)
    });
    return;
  }

  const registerKeyboard = {
    reply_markup: {
      keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
      resize_keyboard: true, one_time_keyboard: true
    }
  };
  await bot.sendMessage(chatId, `📝 *Welcome to M-BINGO, ${firstName}!*\n\nPlease share your contact to register.`, {
    parse_mode: 'Markdown', ...registerKeyboard
  });
});

bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const contact = msg.contact;
  const firstName = msg.from.first_name || 'Player';
  const lastName = msg.from.last_name || '';
  const username = msg.from.username || `user_${userId}`;

  if (!contact || contact.user_id != userId) return bot.sendMessage(chatId, '❌ Please share your own contact.');

  const registered = await ensureRegistered(userId, firstName, lastName, username);

  if (registered) {
    const balance = await getUserBalance(userId);
    await bot.sendMessage(chatId, '✅ Registration complete!', { reply_markup: { remove_keyboard: true } });
    await bot.sendMessage(chatId, `✅ *Welcome, ${firstName}!*\n\n💰 *Balance:* ${formatCurrency(balance)}`, {
      parse_mode: 'Markdown', ...mainMenu(userId)
    });
    await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆕 New User: ${firstName} (${userId})`);
  } else {
    await bot.sendMessage(chatId, '❌ Registration failed. Please try again.');
  }
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const balance = await getUserBalance(userId);
  await bot.sendMessage(chatId, `💰 *Your Balance:* ${formatCurrency(balance)}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/play/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name;
  const lastName = msg.from.last_name || '';
  const username = msg.from.username;

  await ensureRegistered(userId, firstName, lastName, username);

  const stakeOptions = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "10 Birr", callback_data: 'stake_10' }, { text: "20 Birr", callback_data: 'stake_20' }],
        [{ text: "30 Birr", callback_data: 'stake_30' }, { text: "50 Birr", callback_data: 'stake_50' }],
        [{ text: "100 Birr", callback_data: 'stake_100' }, { text: "❌ Cancel", callback_data: 'cancel' }]
      ]
    }
  };
  await bot.sendMessage(chatId, '🎯 *Select your stake amount:*', { parse_mode: 'Markdown', ...stakeOptions });
});

bot.onText(/\/deposit/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
  const appUrl = `${GAME_URL}?mode=deposit&userId=${userId}`;
  await bot.sendMessage(chatId, '💰 *Deposit Section:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: "🏦 Open Deposit Form", web_app: { url: appUrl } }]] }
  });
});

bot.onText(/\/withdraw/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
  const appUrl = `${GAME_URL}?mode=withdraw&userId=${userId}`;
  await bot.sendMessage(chatId, '🏦 *Withdrawal Section:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: "🏦 Open Withdraw Form", web_app: { url: appUrl } }]] }
  });
});

bot.onText(/\/transfer/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
  const appUrl = `${GAME_URL}?mode=transfer&userId=${userId}`;
  await bot.sendMessage(chatId, '🔄 *Transfer Section:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: "🔄 Open Transfer Form", web_app: { url: appUrl } }]] }
  });
});

bot.onText(/\/invite/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const inviteLink = `https://t.me/${config.BOT_USERNAME}?start=ref_${userId}`;
  await bot.sendMessage(chatId, `🎁 *Invite Friends & Earn!*\n\nEarn *${REFERRAL_BONUS} Birr* per friend!\n\nYour Link:\n${inviteLink}`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "📤 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}` }],
        [{ text: "📋 Copy Link", callback_data: 'copy_invite' }]
      ]
    }
  });
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `📖 *Commands*\n\n/start - Start & Register\n/play - Play\n/balance - Check balance\n/deposit - Deposit\n/withdraw - Withdraw\n/transfer - Transfer\n/invite - Invite\n/support - Support`, { parse_mode: 'Markdown' });
});

bot.onText(/\/support/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '📞 *Support:* @frezerabiy\n📧 support@mbingo.com', { parse_mode: 'Markdown' });
});

bot.onText(/\/profile/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  try {
    const r = await axios.get(`${API_URL}/api/users/${userId}`);
    const user = r.data.user;
    await bot.sendMessage(chatId, `👤 *Profile*\n\n📛 Name: ${user.first_name}\n🆔 ID: ${user.telegramId}\n💰 Balance: ${user.balance} ETB\n🏆 Wins: ${user.wins || 0}`, { parse_mode: 'Markdown' });
  } catch (e) { await bot.sendMessage(chatId, '⚠️ Could not fetch profile.'); }
});

// ---------- Unified Callback Query (including admin) ----------
bot.on('callback_query', async (call) => {
  const chatId = call.message.chat.id;
  const userId = call.from.id;
  const data = call.data;
  bot.answerCallbackQuery(call.id);

  // Admin-only checks
  if (data.startsWith('admin_') && userId.toString() !== ADMIN_TELEGRAM_ID) {
    return bot.sendMessage(chatId, '⛔ Unauthorized.');
  }

  if (data.startsWith('stake_')) {
    const stake = parseInt(data.split('_')[1]);
    const appUrl = `${GAME_URL}?stake=${stake}&userId=${userId}`;
    await bot.sendMessage(chatId, `✅ Stake set to ${stake} Birr.\n\nClick below to select your cards:`, {
      reply_markup: { inline_keyboard: [[{ text: "🎮 Open Game", web_app: { url: appUrl } }]] }
    });
    return;
  }

  switch (data) {
    case 'play': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/play'); break;
    case 'balance': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance'); break;
    case 'deposit': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/deposit'); break;
    case 'withdraw': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/withdraw'); break;
    case 'transfer': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/transfer'); break;
    case 'bonus': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/invite'); break;
    case 'help': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/help'); break;
    case 'support': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/support'); break;
    case 'profile': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/profile'); break;
    case 'cancel': await bot.sendMessage(chatId, '❌ Action cancelled.'); break;
    case 'copy_invite': {
      const link = `https://t.me/${config.BOT_USERNAME}?start=ref_${userId}`;
      await bot.sendMessage(chatId, `📋 ${link}`);
      break;
    }
    // Admin actions
    case 'admin_players': {
      try {
        const r = await axios.get(`${API_URL}/api/admin/players?adminId=${ADMIN_TELEGRAM_ID}`);
        const players = r.data;
        let msg = '👥 *Players List*\n\n';
        players.slice(0, 20).forEach((p, i) => msg += `${i+1}. ${p.first_name} - 💰 ${p.balance} ETB\n`);
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching players.'); }
      break;
    }
    case 'admin_deposits': {
      try {
        const r = await axios.get(`${API_URL}/api/admin/deposits?adminId=${ADMIN_TELEGRAM_ID}`);
        const items = r.data;
        if (!items.length) return bot.sendMessage(chatId, 'No pending deposits.');
        let msg = '📥 *Pending Deposits*\n\n';
        items.forEach(d => msg += `👤 ${d.userName} (${d.userId})\n💰 ${formatCurrency(d.amount)}\n🆔 ${d.reference}\n\n`);
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching deposits.'); }
      break;
    }
    case 'admin_withdrawals': {
      try {
        const r = await axios.get(`${API_URL}/api/admin/withdrawals?adminId=${ADMIN_TELEGRAM_ID}`);
        const items = r.data;
        if (!items.length) return bot.sendMessage(chatId, 'No pending withdrawals.');
        let msg = '📤 *Pending Withdrawals*\n\n';
        items.forEach(w => msg += `👤 ${w.userName} (${w.userId})\n💰 ${formatCurrency(w.amount)}\n🏦 ${w.destination}\n\n`);
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching withdrawals.'); }
      break;
    }
    case 'admin_laser': {
      try {
        const r = await axios.get(`${API_URL}/api/admin/stats?adminId=${ADMIN_TELEGRAM_ID}`);
        const s = r.data;
        const totalStakes = Number(s.totalStakes || 0);
        const houseCut = totalStakes * 0.3;
        await bot.sendMessage(chatId, `💸 *Laser (30% Cut)*\n\nTotal Stakes: ${formatCurrency(totalStakes)}\nHouse Cut: ${formatCurrency(houseCut)}`, { parse_mode: 'Markdown' });
      } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching laser.'); }
      break;
    }
    case 'admin_controls': {
      try {
        const r = await axios.get(`${API_URL}/api/admin/players?adminId=${ADMIN_TELEGRAM_ID}`);
        const players = r.data;
        let msg = '🔒 *User Control*\n\n';
        players.slice(0, 20).forEach(p => {
          const status = p.is_banned ? '🟥 BANNED' : '🟩 Active';
          msg += `👤 ${p.first_name} (${p.telegram_id}) - ${status}\n`;
        });
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching users.'); }
      break;
    }
    case 'admin_panel':
      if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
      adminLoginState[chatId] = { step: 'USERNAME' };
      await bot.sendMessage(chatId, '🔐 *Enter Admin Username:*', { parse_mode: 'Markdown' });
      break;
  }
});

// ---------- Text Handler (Admin Login) ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  if (adminLoginState[chatId]) {
    const state = adminLoginState[chatId];
    if (state.step === 'USERNAME') {
      if (text !== ADMIN_USERNAME) { delete adminLoginState[chatId]; return bot.sendMessage(chatId, '❌ Invalid Username.'); }
      adminLoginState[chatId] = { step: 'PASSWORD' };
      return bot.sendMessage(chatId, '🔐 *Enter Admin Password:*', { parse_mode: 'Markdown' });
    }
    if (state.step === 'PASSWORD') {
      delete adminLoginState[chatId];
      if (text !== ADMIN_PASSWORD) return bot.sendMessage(chatId, '❌ Invalid Password.');

      await bot.sendMessage(chatId, '👑 *Admin Panel*', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 Players', callback_data: 'admin_players' }],
            [{ text: '📥 Deposit Requests', callback_data: 'admin_deposits' }],
            [{ text: '📤 Withdraw Requests', callback_data: 'admin_withdrawals' }],
            [{ text: '💸 Laser (30%)', callback_data: 'admin_laser' }],
            [{ text: '🔒 User Control', callback_data: 'admin_controls' }]
          ]
        }
      });
    }
    return;
  }
});

// ---------- Notification Poller ----------
notification.startNotificationPoller(bot);

// ---------- Start the bot (no HTTP server) ----------

const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is running'));
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Health check server on port ${port}`));
console.log('✅ M-BINGO Bot is running (polling only)');

bot.setChatMenuButton({
  menu_button: { type: 'web_app', text: '🎮 Play M-BINGO', web_app: { url: GAME_URL } }
}).catch(() => {});
