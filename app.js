// app.js
require('dotenv').config();
const config = require('./config/env');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const pool = require('./db');
const wallet = require('./services/wallet');
const notification = require('./services/notification');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const server = http.createServer(app);

app.use(helmet());
app.use(compression());
app.use(cors({
  origin: config.CORS_ORIGIN ? config.CORS_ORIGIN.split(',').map(s => s.trim()) : true,
  credentials: false
}));
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// ---------- Health Checks ----------
app.get('/', (req, res) =>
  res.json({ ok: true, service: 'm-bingo', status: 'online', websocket: true, health: '/health', version: '3.2.0' })
);
app.get('/ready', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});
app.get('/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'm-bingo', time: new Date().toISOString() }); }
  catch (e) { res.status(503).json({ ok: false, error: 'database unavailable' }); }
});

// ---------- Helper Functions ----------
async function findUser(idOrTelegram) {
  const value = String(idOrTelegram || '');
  if (!value) return null;
  const result = await pool.query(
    `SELECT * FROM users WHERE id::text = $1 OR telegram_id::text = $1 LIMIT 1`,
    [value]
  );
  return result.rows[0] || null;
}

async function isAdmin(userId) {
  const user = await findUser(userId);
  return !!(user && user.is_admin === true);
}

async function requireAdmin(req, res, next) {
  try {
    const adminId = req.headers['x-admin-id'] || req.body?.adminId || req.query?.adminId;
    if (!(await isAdmin(adminId))) return res.status(403).json({ error: 'Unauthorized' });
    req.admin = await findUser(adminId);
    next();
  } catch (e) { res.status(500).json({ error: 'Authorization error' }); }
}

function verifyTelegramWebAppInitData(initData) {
  if (!initData) return { valid: false, reason: 'missing initData' };
  const botToken = config.BOT_TOKEN;
  if (!botToken) return { valid: false, reason: 'BOT_TOKEN is not configured' };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    if (!hash || !authDate) return { valid: false, reason: 'invalid initData' };
    const age = Math.floor(Date.now() / 1000) - authDate;
    const maxAge = Number(process.env.TELEGRAM_AUTH_MAX_AGE || 86400);
    if (age < -60 || age > maxAge) return { valid: false, reason: 'expired initData' };
    const pairs = [];
    for (const [key, value] of params.entries()) {
      if (key !== 'hash') pairs.push(`${key}=${value}`);
    }
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return { valid: crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash)), reason: 'ok' };
  } catch (e) { return { valid: false, reason: 'invalid initData' }; }
}

function validStake(stake) {
  const n = Number(stake);
  return Number.isFinite(n) && [10, 20, 30, 40, 50, 100].includes(n) ? n : null;
}

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

// ---------- VARIFY.ET ----------
const VARIFY_API_URL = process.env.VARIFY_API_URL || 'https://api.varify.et';
const VARIFY_API_KEY = process.env.VARIFY_API_KEY;
const VARIFY_DEPOSIT_ENDPOINT = process.env.VARIFY_DEPOSIT_ENDPOINT || '/api/deposit';
const VARIFY_WITHDRAW_ENDPOINT = process.env.VARIFY_WITHDRAW_ENDPOINT || '/api/withdraw';

async function callVarifyApi(endpoint, data) {
  if (!VARIFY_API_KEY) throw new Error('VARIFY_API_KEY is not set');
  const response = await axios.post(`${VARIFY_API_URL}${endpoint}`, data, {
    headers: { 'Authorization': `Bearer ${VARIFY_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return response.data;
}

// ============================================================
// GAME LOGIC
// ============================================================
async function startGame(roomId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roomResult = await client.query(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [roomId]);
    if (!roomResult.rows.length) throw new Error('Room not found');
    const room = roomResult.rows[0];

    const playersResult = await client.query(
      `SELECT user_id, cards FROM room_players WHERE room_id = $1 AND left_at IS NULL`,
      [roomId]
    );
    const players = playersResult.rows;

    let totalPool = 0;
    for (const p of players) {
      const cards = Array.isArray(p.cards) ? p.cards : [];
      const payAmount = Number(room.stake) * cards.length;
      if (payAmount > 0) {
        const balanceCheck = await client.query(
          `SELECT balance FROM users WHERE id = $1 AND balance >= $2 FOR UPDATE`,
          [p.user_id, payAmount]
        );
        if (!balanceCheck.rows.length) throw new Error(`User ${p.user_id} has insufficient balance`);
        const before = Number(balanceCheck.rows[0].balance);
        const after = before - payAmount;
        await client.query(`UPDATE users SET balance = $1 WHERE id = $2`, [after, p.user_id]);
        await client.query(
          `INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
           VALUES ($1, 'GAME_STAKE', $2, $3, $4, 'ROOM', $5)`,
          [p.user_id, payAmount, before, after, roomId]
        );
        totalPool += payAmount;
      }
    }

    const commission = totalPool * 0.2;
    const winnerPool = totalPool * 0.8;

    await client.query(
      `INSERT INTO commissions (room_id, total_stake, commission_amount) VALUES ($1, $2, $3)`,
      [roomId, totalPool, commission]
    );

    await client.query(
      `UPDATE rooms SET prize_pool = $1, state = 'PLAYING', status = 'PLAYING',
        started_at = CURRENT_TIMESTAMP, called_numbers = '[]'::jsonb
       WHERE id = $2`,
      [winnerPool, roomId]
    );

    await client.query('COMMIT');
    startNumberCaller(roomId);
    return { success: true, prizePool: winnerPool, totalPool, commission };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error starting game:', e);
    throw e;
  } finally { client.release(); }
}

async function endGame(roomId, winners) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roomResult = await client.query(`SELECT prize_pool FROM rooms WHERE id = $1 FOR UPDATE`, [roomId]);
    if (!roomResult.rows.length) throw new Error('Room not found');
    const prizePool = Number(roomResult.rows[0].prize_pool);
    const prizePerWinner = winners.length ? Number((prizePool / winners.length).toFixed(2)) : 0;

    for (const w of winners) {
      const userBefore = await client.query(`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, [w.user_id]);
      if (!userBefore.rows.length) continue;
      const before = Number(userBefore.rows[0].balance);
      const after = before + prizePerWinner;
      await client.query(`UPDATE users SET balance = $1 WHERE id = $2`, [after, w.user_id]);
      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
         VALUES ($1, 'GAME_WIN', $2, $3, $4, 'ROOM', $5)`,
        [w.user_id, prizePerWinner, before, after, roomId]
      );
      await client.query(
        `UPDATE users SET total_wins = COALESCE(total_wins, 0) + 1,
            total_winnings = COALESCE(total_winnings, 0) + $1,
            total_games_played = COALESCE(total_games_played, 0) + 1
         WHERE id = $2`,
        [prizePerWinner, w.user_id]
      );
    }

    await client.query(
      `UPDATE rooms SET state = 'ENDED', status = 'ENDED', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [roomId]
    );

    try {
      await client.query(
        `INSERT INTO game_history (room_id, prize_pool, commission, ended_at)
         SELECT id, prize_pool,
           (SELECT COALESCE(commission_amount, 0) FROM commissions WHERE room_id = rooms.id LIMIT 1),
           CURRENT_TIMESTAMP
         FROM rooms WHERE id = $1`,
        [roomId]
      );
    } catch (err) { console.warn('game_history insert failed:', err.message); }

    await client.query('COMMIT');
    return { success: true, prizePerWinner };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error ending game:', e);
    throw e;
  } finally { client.release(); }
}

// ---------- Number caller ----------
const roomTimers = new Map();

function startNumberCaller(roomId) {
  stopNumberCaller(roomId);
  const intervalMs = Number(process.env.BINGO_CALL_INTERVAL_MS || 10000);

  const tick = async () => {
    try {
      const roomRes = await pool.query(`SELECT * FROM rooms WHERE id = $1`, [roomId]);
      if (!roomRes.rows.length) return stopNumberCaller(roomId);
      const room = roomRes.rows[0];
      if (room.state !== 'PLAYING') return stopNumberCaller(roomId);

      const already = Array.isArray(room.called_numbers) ? room.called_numbers.map(Number) : [];

      if (already.length >= 75) {
        stopNumberCaller(roomId);
        broadcastToRoom(roomId, 'gameEnd', { winners: [], prizePerWinner: 0, calledNumbers: already });
        await endGame(roomId, []);
        await resetRoomAfterGame(roomId);
        return;
      }

      let num;
      do { num = Math.floor(Math.random() * 75) + 1; } while (already.includes(num));
      already.push(num);

      await pool.query(`UPDATE rooms SET called_numbers = $1::jsonb WHERE id = $2`, [JSON.stringify(already), roomId]);

      const cards = await getGameCards(roomId, already);
      broadcastToRoom(roomId, 'numberCalled', {
        number: num,
        calledNumbers: already,
        calledCount: already.length,
        cards,
      });

      const winners = detectWinners(cards);
      if (winners.length > 0) {
        stopNumberCaller(roomId);
        const enriched = [];
        for (const w of winners) {
          const u = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [w.playerId]);
          enriched.push({ ...w, user_id: w.playerId, playerName: u.rows[0]?.first_name || 'Player' });
        }
        const roomInfo = await pool.query(`SELECT prize_pool FROM rooms WHERE id = $1`, [roomId]);
        const prizePool = Number(roomInfo.rows[0]?.prize_pool || 0);
        const prizePerWinner = enriched.length ? Number((prizePool / enriched.length).toFixed(2)) : 0;
        await endGame(roomId, enriched.map(w => ({ user_id: w.playerId })));
        broadcastToRoom(roomId, 'gameEnd', { winners: enriched, prizePerWinner, calledNumbers: already });
        setTimeout(() => resetRoomAfterGame(roomId), 10000);
        return;
      }

      const t = setTimeout(tick, intervalMs);
      roomTimers.set(roomId, t);
    } catch (e) {
      console.error('numberCaller error:', e);
      stopNumberCaller(roomId);
    }
  };

  const t = setTimeout(tick, intervalMs);
  roomTimers.set(roomId, t);
}

function stopNumberCaller(roomId) {
  const timer = roomTimers.get(roomId);
  if (timer) { clearTimeout(timer); roomTimers.delete(roomId); }
}

async function resetRoomAfterGame(roomId) {
  try {
    await pool.query(
      `UPDATE room_players SET cards = '[]'::jsonb, is_winner = FALSE, winning_amount = 0 WHERE room_id = $1`,
      [roomId]
    );
    await pool.query(
      `UPDATE rooms
       SET state = 'SELECTING', status = 'SELECTING',
           called_numbers = '[]'::jsonb, prize_pool = 0,
           game_number = COALESCE(game_number, 0) + 1,
           created_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [roomId]
    );
    const snap = await roomSnapshot(roomId);
    if (snap) {
      broadcastToRoom(roomId, 'gameStateUpdate', {
        status: 'selecting',
        roomId,
        stake: Number(snap.stake),
        gameNumber: snap.game_number,
        selectedCards: [],
        selectionTimeLeft: Number(snap.countdown_seconds || 60),
        players: snap.players,
      });
    }
  } catch (e) { console.error('Room reset error:', e); }
}

async function roomSnapshot(roomId) {
  const result = await pool.query(
    `SELECT r.*,
            COALESCE(
              jsonb_agg(
                jsonb_build_object('user_id', rp.user_id, 'cards', rp.cards, 'is_winner', rp.is_winner)
              ) FILTER (WHERE rp.user_id IS NOT NULL),
              '[]'::jsonb
            ) AS players
     FROM rooms r
     LEFT JOIN room_players rp ON rp.room_id = r.id AND rp.left_at IS NULL
     WHERE r.id = $1
     GROUP BY r.id`,
    [roomId]
  );
  return result.rows[0] || null;
}

async function getGameCards(roomId, calledNumbers = []) {
  const calledSet = new Set((calledNumbers || []).map(Number));
  const result = [];
  const playersRes = await pool.query(
    `SELECT rp.user_id, rp.cards FROM room_players rp WHERE rp.room_id = $1 AND rp.left_at IS NULL`,
    [roomId]
  );
  for (const row of playersRes.rows) {
    const cardNumbers = Array.isArray(row.cards) ? row.cards.map(Number) : [];
    for (const cardNumber of cardNumbers) {
      const cardRes = await pool.query(
        `SELECT card_number, board FROM bingo_cards WHERE card_number = $1`,
        [cardNumber]
      );
      if (!cardRes.rows.length) continue;
      const board = cardRes.rows[0].board;
      const marked = Array(5).fill().map(() => Array(5).fill(false));
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          const val = board[r][c];
          if (val === '★' || val === 0) marked[r][c] = true;
          else if (calledSet.has(Number(val))) marked[r][c] = true;
        }
      }
      result.push({ playerId: String(row.user_id), cardNumber, board, marked });
    }
  }
  return result;
}

function detectWinners(cards) {
  const winners = [];
  for (const card of cards) {
    const patterns = [];
    const m = card.marked;
    const b = card.board;
    for (let r = 0; r < 5; r++) {
      if (m[r].every(Boolean)) patterns.push({ type: 'row', index: r, label: `Row ${r + 1}` });
    }
    for (let c = 0; c < 5; c++) {
      let full = true;
      for (let r = 0; r < 5; r++) if (!m[r][c]) { full = false; break; }
      if (full) patterns.push({ type: 'column', index: c, label: `Column ${c + 1}` });
    }
    let d1 = true, d2 = true;
    for (let i = 0; i < 5; i++) {
      if (!m[i][i]) d1 = false;
      if (!m[i][4 - i]) d2 = false;
    }
    if (d1) patterns.push({ type: 'diagonal', index: 0, label: 'Diagonal ↘' });
    if (d2) patterns.push({ type: 'diagonal', index: 1, label: 'Diagonal ↙' });
    if (m[0][0] && m[0][4] && m[4][0] && m[4][4]) patterns.push({ type: 'corner', index: 0, label: 'Corners' });
    let fullHouse = true;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (!m[r][c]) fullHouse = false;
    if (fullHouse) patterns.push({ type: 'full', index: 0, label: 'Full House' });
    if (patterns.length) {
      winners.push({ playerId: card.playerId, cardNumber: card.cardNumber, board: b, marked: m, patterns, bingo: true });
    }
  }
  return winners;
}

function broadcastToRoom(roomId, type, data) {
  for (const ws of clients.values()) {
    if (ws.roomId === roomId) send(ws, type, data);
  }
}

// ============================================================
// API ROUTES
// ============================================================
app.post('/api/users/register', async (req, res) => {
  try {
    const { telegramId, username, firstName, lastName, photoUrl, telegramInitData } = req.body;
    if (!telegramId || !firstName)
      return res.status(400).json({ success: false, error: 'telegramId and firstName required' });

    const telegramCheck = verifyTelegramWebAppInitData(telegramInitData);
    const browserTesting = config.ALLOW_BROWSER_TESTING;
    const botTokenHeader = String(req.headers['x-bot-token'] || '');
    const configuredBotToken = String(config.BOT_TOKEN || '');
    const botAuthorized = Boolean(configuredBotToken && botTokenHeader && botTokenHeader === configuredBotToken);

    if (!telegramCheck.valid && !browserTesting && !botAuthorized)
      return res.status(401).json({ success: false, error: 'Telegram authentication required', reason: telegramCheck.reason });

    if (telegramCheck.valid && !botAuthorized) {
      const params = new URLSearchParams(telegramInitData);
      const tgUser = JSON.parse(params.get('user') || '{}');
      if (String(tgUser.id) !== String(telegramId))
        return res.status(401).json({ success: false, error: 'Telegram user mismatch' });
    }

    const existing = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
    if (existing.rows.length) {
      await pool.query(
        `UPDATE users SET username = COALESCE($2, username), first_name = COALESCE($3, first_name),
          last_name = COALESCE($4, last_name), photo_url = COALESCE($5, photo_url),
          last_login = CURRENT_TIMESTAMP WHERE telegram_id = $1`,
        [telegramId, username || null, firstName || null, lastName || null, photoUrl || null]
      );
      const updated = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
      return res.json({ success: true, user: updated.rows[0], message: 'User already exists' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, balance, last_login)
         VALUES ($1, $2, $3, $4, $5, 50, CURRENT_TIMESTAMP) RETURNING *`,
        [telegramId, username || '', firstName, lastName || '', photoUrl || null]
      );
      const user = userResult.rows[0];
      await wallet.addLedger(client, user.id, 'SIGNUP_BONUS', 50, 0, 50, 'USER', user.id);
      await client.query('COMMIT');
      res.json({ success: true, user, message: 'User registered with 50 Birr bonus!' });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/users/:userId', async (req, res) => {
  try {
    const user = await findUser(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({
      success: true,
      user: {
        id: user.id, telegramId: user.telegram_id, username: user.username,
        firstName: user.first_name, lastName: user.last_name, balance: Number(user.balance),
        gamesPlayed: Number(user.total_games_played || 0), wins: Number(user.total_wins || 0),
        createdAt: user.created_at
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const user = await findUser(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id, first_name: user.first_name, username: user.username,
      balance: Number(user.balance), locked_balance: Number(user.locked_balance),
      withdrawal_reserved: Number(user.withdrawal_reserved || 0),
      available_balance: Math.max(0, Number(user.balance) - Number(user.withdrawal_reserved || 0)),
      total_wins: Number(user.total_wins || 0), total_games_played: Number(user.total_games_played || 0),
      total_winnings: Number(user.total_winnings || 0)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cards', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT card_number, board FROM bingo_cards WHERE is_active = TRUE ORDER BY card_number LIMIT 200`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.stake, r.status, r.state, r.prize_pool, r.game_number,
              COUNT(rp.id)::int AS player_count
       FROM rooms r LEFT JOIN room_players rp ON rp.room_id = r.id AND rp.left_at IS NULL
       WHERE r.state <> 'ENDED' GROUP BY r.id ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/by-username/:username', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM users WHERE username ILIKE $1`, [req.params.username]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user: result.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/transfer', async (req, res) => {
  const { fromId, toId, amount } = req.body;
  try {
    await wallet.transferBalance(fromId, toId, amount);
    res.json({ success: true, message: 'Transfer successful' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const user = await findUser(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const result = await pool.query(
      `SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    );
    res.json({ success: true, transactions: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/games/:userId', async (req, res) => {
  try {
    const user = await findUser(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const roomsQuery = await pool.query(`SELECT DISTINCT room_id FROM room_players WHERE user_id = $1`, [user.id]);
    const roomIds = roomsQuery.rows.map(r => r.room_id);
    if (roomIds.length === 0) return res.json({ success: true, games: [] });
    const gamesResult = await pool.query(
      `SELECT * FROM game_history WHERE room_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 50`,
      [roomIds]
    );
    res.json({ success: true, games: gamesResult.rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ---------- DEPOSIT ----------
app.post('/api/deposit/request', async (req, res) => {
  const { userId, amount, method, phone } = req.body;
  const user = await findUser(userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  const value = safeNumber(amount);
  if (value < 50 || value > 5000)
    return res.status(400).json({ success: false, message: 'Amount must be between 50 and 5000' });
  if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });
  try {
    const manualRef = 'manual-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    const deposit = await pool.query(
      `INSERT INTO deposits (user_id, amount, method, reference, varify_reference, varify_status, status)
       VALUES ($1, $2, $3, $4, $5, 'MANUAL', 'PENDING') RETURNING *`,
      [user.id, value, method, manualRef, manualRef]
    );
    await notification.sendAdminNotification(
      `💰 Deposit request\nUser: ${user.first_name} (${user.telegram_id})\nAmount: ${value} Birr\nMethod: ${method}\nPhone: ${phone}\nReference: ${manualRef}`
    );
    res.json({ success: true, deposit: deposit.rows[0], varify_reference: manualRef });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ success: false, message: 'Failed to create deposit request' });
  }
});

// ---------- WITHDRAW ----------
app.post('/api/withdraw/request', async (req, res) => {
  const { userId, amount, method, account } = req.body;
  const user = await findUser(userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  const value = safeNumber(amount);
  if (value <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });
  if (!account) return res.status(400).json({ success: false, message: 'Account is required' });

  const balanceResult = await pool.query(
    `SELECT balance, COALESCE(withdrawal_reserved, 0) AS withdrawal_reserved FROM users WHERE id = $1`,
    [user.id]
  );
  const balance = Number(balanceResult.rows[0].balance);
  const reserved = Number(balanceResult.rows[0].withdrawal_reserved || 0);
  if (balance - reserved < value)
    return res.status(400).json({ success: false, message: 'Insufficient balance' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const manualRef = 'manual-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    const withdrawal = await client.query(
      `INSERT INTO withdrawals (user_id, amount, method, destination, varify_reference, varify_status, status)
       VALUES ($1, $2, $3, $4, $5, 'MANUAL', 'PENDING') RETURNING *`,
      [user.id, value, method || 'UNKNOWN', account, manualRef]
    );
    await client.query(
      `UPDATE users SET withdrawal_reserved = COALESCE(withdrawal_reserved, 0) + $1 WHERE id = $2`,
      [value, user.id]
    );
    await client.query('COMMIT');
    await notification.sendAdminNotification(
      `🏦 Withdrawal request\nUser: ${user.first_name} (${user.telegram_id})\nAmount: ${value} Birr\nMethod: ${method}\nAccount: ${account}\nReference: ${manualRef}`
    );
    res.json({ success: true, withdrawal: withdrawal.rows[0], varify_reference: manualRef });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Withdrawal error:', error);
    res.status(500).json({ success: false, message: 'Failed to create withdrawal request' });
  } finally { client.release(); }
});

// ---------- Webhooks ----------
app.post('/webhook/varify/deposit', async (req, res) => {
  const { reference, transaction_id, status } = req.body;
  try {
    const depositResult = await pool.query(
      `SELECT * FROM deposits WHERE varify_reference = $1 OR reference = $1 ORDER BY created_at DESC LIMIT 1`,
      [reference || transaction_id]
    );
    if (!depositResult.rows.length) return res.status(404).json({ error: 'Deposit not found' });
    const deposit = depositResult.rows[0];
    if (deposit.varify_status === 'MANUAL' || deposit.status === 'APPROVED' || deposit.status === 'REJECTED')
      return res.json({ received: true });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (status === 'COMPLETED' || status === 'SUCCESS') {
        const user = await client.query(`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, [deposit.user_id]);
        const before = Number(user.rows[0].balance);
        const after = before + Number(deposit.amount);
        await client.query(`UPDATE users SET balance = $1 WHERE id = $2`, [after, deposit.user_id]);
        await wallet.addLedger(client, deposit.user_id, 'DEPOSIT', Number(deposit.amount), before, after, 'DEPOSIT', deposit.id);
        await client.query(
          `UPDATE deposits SET status = 'APPROVED', varify_status = 'COMPLETED', approved_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [deposit.id]
        );
      } else {
        await client.query(
          `UPDATE deposits SET status = 'REJECTED', varify_status = 'FAILED', rejected_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [deposit.id]
        );
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ received: true });
  } catch (error) { console.error('Deposit webhook error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/webhook/varify/withdraw', async (req, res) => {
  const { reference, transaction_id, status } = req.body;
  try {
    const withdrawalResult = await pool.query(
      `SELECT * FROM withdrawals WHERE varify_reference = $1 OR reference = $1 ORDER BY created_at DESC LIMIT 1`,
      [reference || transaction_id]
    );
    if (!withdrawalResult.rows.length) return res.status(404).json({ error: 'Withdrawal not found' });
    const withdrawal = withdrawalResult.rows[0];
    if (withdrawal.varify_status === 'MANUAL' || withdrawal.status === 'APPROVED' || withdrawal.status === 'REJECTED')
      return res.json({ received: true });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (status === 'COMPLETED' || status === 'SUCCESS') {
        await client.query(
          `UPDATE withdrawals SET status = 'APPROVED', varify_status = 'COMPLETED', approved_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [withdrawal.id]
        );
      } else {
        await client.query(
          `UPDATE users SET withdrawal_reserved = GREATEST(0, COALESCE(withdrawal_reserved, 0) - $1) WHERE id = $2`,
          [Number(withdrawal.amount), withdrawal.user_id]
        );
        await client.query(
          `UPDATE withdrawals SET status = 'REJECTED', varify_status = 'FAILED', rejected_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [withdrawal.id]
        );
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ received: true });
  } catch (error) { console.error('Withdrawal webhook error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ---------- Admin Endpoints ----------
app.get('/api/admin/players', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, telegram_id, first_name, username, balance, locked_balance,
              total_wins, total_games_played, total_winnings, is_admin, status, is_banned
       FROM users ORDER BY balance DESC`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/user/:userId', requireAdmin, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, telegram_id, first_name, username, balance, locked_balance,
              withdrawal_reserved, total_wins, total_games_played, total_winnings,
              is_admin, is_banned, created_at, last_login
       FROM users WHERE id = $1`, [req.params.userId]
    );
    if (!userResult.rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const txResult = await pool.query(
      `SELECT type, amount, balance_before, balance_after, created_at
       FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.userId]
    );
    res.json({ success: true, user: userResult.rows[0], transactions: txResult.rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/admin/data', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name AS name, username, telegram_id, balance, locked_balance,
              total_wins AS wins, total_games_played AS games, is_banned
       FROM users ORDER BY balance DESC LIMIT 500`
    );
    res.json({ success: true, players: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const expectedUsername = config.ADMIN_USERNAME || '';
    const passwordHash = config.ADMIN_PASSWORD_HASH || '';
    const adminTelegramId = config.ADMIN_TELEGRAM_ID || '';
    if (!expectedUsername || !passwordHash || !adminTelegramId)
      return res.status(500).json({ success: false, message: 'Server admin config missing' });
    const usernameValid = username === expectedUsername;
    const passwordValid = await bcrypt.compare(password || '', passwordHash);
    if (!usernameValid || !passwordValid)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const adminUser = await findUser(adminTelegramId);
    if (!adminUser) return res.status(404).json({ success: false, message: 'Admin user not found' });
    if (adminUser.is_admin !== true) return res.status(403).json({ success: false, message: 'User is not an admin' });
    res.json({ success: true, adminId: adminUser.id });
  } catch (error) { console.error('Admin login error:', error); res.status(500).json({ success: false, message: 'Internal server error' }); }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)::int AS "totalPlayers",
        (SELECT COUNT(*) FROM rooms WHERE state = 'PLAYING')::int AS "activeGames",
        (SELECT COUNT(*) FROM users WHERE status = 'ONLINE')::int AS "onlinePlayers",
        (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions
         WHERE type = 'WIN' AND created_at::date = CURRENT_DATE) AS "todayPayouts",
        (SELECT COUNT(*) FROM rooms)::int AS "totalRooms",
        (SELECT COALESCE(SUM(g.stake * g.total_cards), 0) FROM game_history g)::numeric AS "totalStakes"
    `);
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/commission', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT COALESCE(SUM(commission_amount), 0) AS total FROM commissions`);
    res.json({ totalCommission: Number(result.rows[0].total) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT d.*, u.first_name AS "userName", u.telegram_id AS "userId"
     FROM deposits d JOIN users u ON u.id = d.user_id
     WHERE d.status = 'PENDING' ORDER BY d.created_at DESC`
  );
  res.json(result.rows);
});

app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT w.*, u.first_name AS "userName", u.telegram_id AS "userId"
     FROM withdrawals w JOIN users u ON u.id = w.user_id
     WHERE w.status = 'PENDING' ORDER BY w.created_at DESC`
  );
  res.json(result.rows);
});

app.post('/api/admin/deposits/approve', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dep = await client.query(
      `SELECT * FROM deposits WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [req.body.depositId]
    );
    if (!dep.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }); }
    const d = dep.rows[0];
    const user = await client.query(
      `SELECT balance FROM users WHERE id = $1 FOR UPDATE`, [d.user_id]
    );
    const before = Number(user.rows[0].balance);
    const after = before + Number(d.amount);
    await client.query(`UPDATE users SET balance = $1 WHERE id = $2`, [after, d.user_id]);
    await wallet.addLedger(client, d.user_id, 'DEPOSIT', Number(d.amount), before, after, 'DEPOSIT', d.id);
    await client.query(
      `UPDATE deposits SET status = 'APPROVED', admin_id = $1, approved_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [req.admin.id, d.id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/api/admin/deposits/reject', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dep = await client.query(
      `SELECT * FROM deposits WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [req.body.depositId]
    );
    if (!dep.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }); }
    await client.query(
      `UPDATE deposits SET status = 'REJECTED', admin_id = $1, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $2
       WHERE id = $3`,
      [req.admin.id, String(req.body.reason || 'Rejected by admin'), dep.rows[0].id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/api/admin/withdrawals/approve', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wr = await client.query(
      `SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [req.body.withdrawalId]
    );
    if (!wr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Withdrawal not found' }); }
    const w = wr.rows[0];
    const user = await client.query(`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, [w.user_id]);
    const before = Number(user.rows[0].balance);
    if (before < Number(w.amount)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }); }
    const after = before - Number(w.amount);
    await client.query(
      `UPDATE users SET balance = $1,
         withdrawal_reserved = GREATEST(0, COALESCE(withdrawal_reserved, 0) - $2) WHERE id = $3`,
      [after, Number(w.amount), w.user_id]
    );
    await wallet.addLedger(client, w.user_id, 'WITHDRAWAL', Number(w.amount), before, after, 'WITHDRAWAL', w.id);
    await client.query(
      `UPDATE withdrawals SET status = 'APPROVED', admin_id = $1, approved_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [req.admin.id, w.id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/api/admin/withdrawals/reject', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wr = await client.query(
      `SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [req.body.withdrawalId]
    );
    if (!wr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Withdrawal not found' }); }
    const w = wr.rows[0];
    await client.query(
      `UPDATE users SET withdrawal_reserved = GREATEST(0, COALESCE(withdrawal_reserved, 0) - $1) WHERE id = $2`,
      [Number(w.amount), w.user_id]
    );
    await client.query(
      `UPDATE withdrawals SET status = 'REJECTED', admin_id = $1, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $2
       WHERE id = $3`,
      [req.admin.id, String(req.body.reason || 'Rejected by admin'), w.id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/api/admin/balance/add', requireAdmin, async (req, res) => {
  try {
    await wallet.adminAdjustBalance(req.admin.id, req.body.userId, safeNumber(req.body.amount), 'ADMIN_DEPOSIT');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/balance/remove', requireAdmin, async (req, res) => {
  try {
    await wallet.adminAdjustBalance(req.admin.id, req.body.userId, -safeNumber(req.body.amount), 'ADMIN_WITHDRAW');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- WebSocket ----------
const wss = new WebSocket.Server({
  server,
  verifyClient: (info) => { console.log('🔌 WebSocket connection attempt'); return true; }
});
console.log('✅ WebSocket server attached');

const clients = new Map();

function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}
function sendError(ws, message) { send(ws, 'gameError', { message }); }

async function broadcastLobbyData() {
  try {
    const result = await pool.query(`
      WITH room_data AS (
        SELECT r.stake, r.state, r.countdown_seconds, r.created_at,
          COALESCE(SUM(jsonb_array_length(rp.cards)), 0) AS selected_cards,
          COUNT(DISTINCT rp.user_id) AS players
        FROM rooms r
        LEFT JOIN room_players rp ON rp.room_id = r.id AND rp.left_at IS NULL
        WHERE r.state <> 'ENDED'
        GROUP BY r.id, r.stake, r.state, r.countdown_seconds, r.created_at
      )
      SELECT stake, SUM(selected_cards) AS total_selected_cards, SUM(players) AS total_players,
        MAX(CASE WHEN state = 'PLAYING' THEN 1 ELSE 0 END) AS has_playing,
        MAX(CASE WHEN state = 'SELECTING' THEN 1 ELSE 0 END) AS has_selecting,
        MIN(CASE WHEN state = 'SELECTING' THEN EXTRACT(EPOCH FROM (NOW() - created_at)) END) AS elapsed_selecting_seconds,
        MIN(CASE WHEN state = 'SELECTING' THEN countdown_seconds END) AS selecting_countdown
      FROM room_data GROUP BY stake
    `);

    const rows = result.rows;
    const allStakes = [10, 20, 50];
    const data = allStakes.map(stake => {
      const found = rows.find(r => Number(r.stake) === stake);
      if (!found) return { stake, selectedCardsCount: 0, playersCount: 0, status: 'waiting', selectionTimeLeft: 0 };
      let status = 'waiting';
      let selectionTimeLeft = 0;
      if (Number(found.has_playing) > 0) status = 'playing';
      else if (Number(found.has_selecting) > 0) {
        status = 'selecting';
        const elapsed = Number(found.elapsed_selecting_seconds || 0);
        const countdown = Number(found.selecting_countdown || config.BINGO_SELECTION_SECONDS || 60);
        selectionTimeLeft = Math.max(0, Math.ceil(countdown - elapsed));
      }
      return {
        stake: Number(stake),
        selectedCardsCount: Number(found.total_selected_cards || 0),
        playersCount: Number(found.total_players || 0),
        status, selectionTimeLeft
      };
    });

    const payload = { type: 'lobbyData', data };
    for (const ws of clients.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    }
  } catch (e) { console.error('broadcastLobbyData error:', e); }
}

setInterval(broadcastLobbyData, 5000);

// ---------- WebSocket Handlers ----------
wss.on('connection', (ws) => {
  console.log('✅ WebSocket client connected');
  send(ws, 'connected', { message: 'Connected to M-BINGO server' });

  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      const type = message.type;
      const data = message.data || {};

      switch (type) {
        case 'auth': {
          const user = await findUser(data.userId);
          if (!user) return sendError(ws, 'User authentication failed');
          if (user.is_banned === true) return sendError(ws, 'You are banned from playing.');
          ws.userId = String(user.id);
          clients.set(ws.userId, ws);
          await pool.query(`UPDATE users SET status = 'ONLINE', last_login = CURRENT_TIMESTAMP WHERE id = $1`, [user.id]);

          const active = await pool.query(
            `SELECT rp.room_id FROM room_players rp JOIN rooms r ON r.id = rp.room_id
             WHERE rp.user_id = $1 AND rp.left_at IS NULL AND r.state IN ('SELECTING', 'PLAYING')
             ORDER BY rp.joined_at DESC LIMIT 1`, [user.id]
          );
          if (active.rows.length) ws.roomId = active.rows[0].room_id;
          const snapshot = ws.roomId ? await roomSnapshot(ws.roomId) : null;
          send(ws, 'init', {
            playerId: String(user.id),
            balance: Number(user.balance),
            players: snapshot ? snapshot.players : [],
            gameState: snapshot
              ? {
                  status: String(snapshot.state).toLowerCase(),
                  stake: Number(snapshot.stake),
                  gameNumber: Number(snapshot.game_number),
                  calledNumbers: Array.isArray(snapshot.called_numbers) ? snapshot.called_numbers : [],
                  selectedCards: snapshot.players.flatMap((p) => p.cards || []),
                  selectionTimeLeft: 0,
                  isPlaying: snapshot.state === 'PLAYING',
                }
              : { status: 'waiting' },
          });
          if (snapshot?.state === 'PLAYING') {
            const calledNumbers = Array.isArray(snapshot.called_numbers) ? snapshot.called_numbers : [];
            const cards = await getGameCards(ws.roomId, calledNumbers);
            send(ws, 'gameStart', {
              roomId: ws.roomId, gameNumber: snapshot.game_number, stake: Number(snapshot.stake),
              totalCards: cards.length, prizePool: Number(snapshot.prize_pool),
              calledNumbers, calledCount: calledNumbers.length, cards,
            });
          }
          break;
        }

        case 'startSelection': {
          const user = await findUser(data.userId || ws.userId);
          const stake = validStake(data.stake);
          if (!user) return sendError(ws, 'Please register/login first');
          if (user.is_banned === true) return sendError(ws, 'You are banned from playing.');
          if (!stake) return sendError(ws, 'Invalid stake.');

          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            const playingRoom = await client.query(
              `SELECT * FROM rooms WHERE stake = $1 AND state = 'PLAYING' ORDER BY created_at DESC LIMIT 1`, [stake]
            );
            if (playingRoom.rows.length) {
              const room = playingRoom.rows[0];
              const existingEntry = await client.query(
                `SELECT id FROM room_players WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL FOR UPDATE`,
                [room.id, user.id]
              );
              if (!existingEntry.rows.length) {
                await client.query(
                  `INSERT INTO room_players (room_id, user_id, cards, is_ready) VALUES ($1, $2, '[]'::jsonb, FALSE)`,
                  [room.id, user.id]
                );
              }
              await client.query('COMMIT');
              ws.userId = String(user.id);
              ws.roomId = room.id;
              clients.set(ws.userId, ws);
              const snapshot = await roomSnapshot(room.id);
              const calledNumbers = Array.isArray(snapshot.called_numbers) ? snapshot.called_numbers : [];
              const cards = await getGameCards(room.id, calledNumbers);
              send(ws, 'gameStart', {
                roomId: room.id, gameNumber: snapshot.game_number, stake: Number(snapshot.stake),
                totalCards: cards.length, prizePool: Number(snapshot.prize_pool),
                calledNumbers, calledCount: calledNumbers.length, cards,
              });
              break;
            }

            const roomResult = await client.query(
              `SELECT * FROM rooms WHERE stake = $1 AND state IN ('WAITING','SELECTING') ORDER BY created_at LIMIT 1 FOR UPDATE`,
              [stake]
            );
            let room;
            if (roomResult.rows.length) room = roomResult.rows[0];
            else {
              const newRoom = await client.query(
                `INSERT INTO rooms (stake, state, status, countdown_seconds, created_at)
                 VALUES ($1, 'SELECTING', 'SELECTING', $2, CURRENT_TIMESTAMP) RETURNING *`,
                [stake, config.BINGO_SELECTION_SECONDS || 60]
              );
              room = newRoom.rows[0];
            }
            const joined = await client.query(
              `SELECT id FROM room_players WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL FOR UPDATE`,
              [room.id, user.id]
            );
            if (!joined.rows.length) {
              await client.query(
                `INSERT INTO room_players (room_id, user_id, cards, is_ready) VALUES ($1, $2, '[]'::jsonb, FALSE)`,
                [room.id, user.id]
              );
            }
            await client.query(`UPDATE rooms SET status = 'SELECTING', state = 'SELECTING' WHERE id = $1`, [room.id]);
            await client.query('COMMIT');
            ws.userId = String(user.id);
            ws.roomId = room.id;
            clients.set(ws.userId, ws);
            const snapshot = await roomSnapshot(room.id);
            if (snapshot) {
              const selectedCards = snapshot.players.flatMap((p) => p.cards || []);
              broadcastToRoom(room.id, 'gameStateUpdate', {
                status: 'selecting', roomId: room.id, stake: Number(snapshot.stake),
                gameNumber: snapshot.game_number, selectedCards,
                selectionTimeLeft: Number(room.countdown_seconds || config.BINGO_SELECTION_SECONDS || 60),
                players: snapshot.players,
              });
            }
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            sendError(ws, e.message);
          } finally { client.release(); }
          break;
        }

        case 'selectCard': {
          if (!ws.userId) return sendError(ws, 'Not authenticated');
          if (!ws.roomId) return sendError(ws, 'Start game selection first');
          const cardNumber = Number(data.cardNumber);
          if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 200)
            return sendError(ws, 'Invalid card number');

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const roomResult = await client.query(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [ws.roomId]);
            if (!roomResult.rows.length) throw new Error('Room not found');
            const room = roomResult.rows[0];
            if (room.state !== 'SELECTING') throw new Error('Card selection is closed');
            const cardResult = await client.query(
              `SELECT card_number FROM bingo_cards WHERE card_number = $1 AND is_active = TRUE`, [cardNumber]
            );
            if (!cardResult.rows.length) throw new Error('Card not found');

            const used = await client.query(
              `SELECT user_id, cards FROM room_players WHERE room_id = $1 AND left_at IS NULL FOR UPDATE`, [ws.roomId]
            );
            for (const p of used.rows) {
              const cards = Array.isArray(p.cards) ? p.cards.map(Number) : [];
              if (cards.includes(cardNumber)) throw new Error('This card is already selected');
            }
            const me = used.rows.find((p) => String(p.user_id) === String(ws.userId));
            if (!me) throw new Error('You are not in this room');
            const myCards = Array.isArray(me.cards) ? me.cards.map(Number) : [];
            if (myCards.includes(cardNumber)) throw new Error('You already selected this card');
            myCards.push(cardNumber);

            await client.query(
              `UPDATE room_players SET cards = $1::jsonb WHERE room_id = $2 AND user_id = $3`,
              [JSON.stringify(myCards), ws.roomId, ws.userId]
            );
            await client.query('COMMIT');
            send(ws, 'cardSelectionResult', { success: true, cardNumber, cards: myCards });
            const snapshot = await roomSnapshot(ws.roomId);
            if (snapshot) {
              const selectedCards = snapshot.players.flatMap((p) => p.cards || []);
              broadcastToRoom(ws.roomId, 'gameStateUpdate', {
                status: 'selecting', roomId: ws.roomId, stake: Number(snapshot.stake),
                gameNumber: snapshot.game_number, selectedCards,
                selectionTimeLeft: snapshot.state === 'SELECTING'
                  ? Math.max(0, Math.ceil((new Date(snapshot.created_at).getTime() +
                      Number(snapshot.countdown_seconds || 60) * 1000 - Date.now()) / 1000))
                  : 0,
                players: snapshot.players,
              });
            }
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            send(ws, 'cardSelectionResult', { success: false, message: e.message });
          } finally { client.release(); }
          break;
        }

        case 'deselectCard': {
          if (!ws.userId || !ws.roomId) return sendError(ws, 'Not authenticated or no room');
          const cardNumber = Number(data.cardNumber);
          if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 200)
            return sendError(ws, 'Invalid card number');

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const roomResult = await client.query(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [ws.roomId]);
            if (!roomResult.rows.length) throw new Error('Room not found');
            const room = roomResult.rows[0];
            if (room.state !== 'SELECTING') throw new Error('Card selection is closed');

            const me = await client.query(
              `SELECT cards FROM room_players WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL FOR UPDATE`,
              [ws.roomId, ws.userId]
            );
            if (!me.rows.length) throw new Error('You are not in this room');
            let myCards = Array.isArray(me.rows[0].cards) ? me.rows[0].cards.map(Number) : [];
            const idx = myCards.indexOf(cardNumber);
            if (idx === -1) throw new Error('Card not selected by you');
            myCards.splice(idx, 1);

            await client.query(
              `UPDATE room_players SET cards = $1::jsonb WHERE room_id = $2 AND user_id = $3`,
              [JSON.stringify(myCards), ws.roomId, ws.userId]
            );
            await client.query('COMMIT');
            send(ws, 'cardSelectionResult', { success: true, cardNumber, cards: myCards });
            const snapshot = await roomSnapshot(ws.roomId);
            if (snapshot) {
              const selectedCards = snapshot.players.flatMap((p) => p.cards || []);
              broadcastToRoom(ws.roomId, 'gameStateUpdate', {
                status: 'selecting', roomId: ws.roomId, stake: Number(snapshot.stake),
                gameNumber: snapshot.game_number, selectedCards,
                selectionTimeLeft: snapshot.state === 'SELECTING'
                  ? Math.max(0, Math.ceil((new Date(snapshot.created_at).getTime() +
                      Number(snapshot.countdown_seconds || 60) * 1000 - Date.now()) / 1000))
                  : 0,
                players: snapshot.players,
              });
            }
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            send(ws, 'cardSelectionResult', { success: false, message: e.message });
          } finally { client.release(); }
          break;
        }

        // ─────────────────────────────────────────────────────────
        // NEW: resetSelection – clears all cards if game hasn't started
        // ─────────────────────────────────────────────────────────
        case 'resetSelection': {
          if (!ws.userId || !ws.roomId) return sendError(ws, 'Not authenticated or no room');
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            const roomRes = await client.query(
              `SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [ws.roomId]
            );
            if (!roomRes.rows.length) throw new Error('Room not found');
            const room = roomRes.rows[0];

            // Only reset if the game hasn't started
            if (room.state === 'PLAYING') {
              await client.query('ROLLBACK');
              break;
            }

            // Clear all card selections
            await client.query(
              `UPDATE room_players SET cards = '[]'::jsonb, is_winner = FALSE, winning_amount = 0
               WHERE room_id = $1`,
              [ws.roomId]
            );

            // Reset room's countdown and state
            await client.query(
              `UPDATE rooms
               SET state = 'SELECTING', status = 'SELECTING',
                   called_numbers = '[]'::jsonb,
                   countdown_seconds = $1,
                   created_at = CURRENT_TIMESTAMP
               WHERE id = $2`,
              [config.BINGO_SELECTION_SECONDS || 60, ws.roomId]
            );

            await client.query('COMMIT');

            const snapshot = await roomSnapshot(ws.roomId);
            if (snapshot) {
              broadcastToRoom(ws.roomId, 'gameStateUpdate', {
                status: 'selecting',
                roomId: ws.roomId,
                stake: Number(snapshot.stake),
                gameNumber: snapshot.game_number,
                selectedCards: [],
                selectionTimeLeft: Number(snapshot.countdown_seconds || 60),
                players: snapshot.players,
              });
            }
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('resetSelection error:', e.message);
          } finally { client.release(); }
          break;
        }

        case 'startGame': {
          if (!ws.userId || !ws.roomId) return sendError(ws, 'Join a game first');
          const room = await roomSnapshot(ws.roomId);
          if (!room) return sendError(ws, 'Room not found');
          const readyPlayers = room.players.filter((p) => Array.isArray(p.cards) && p.cards.length);
          if (readyPlayers.length < Number(room.min_players || 2))
            return sendError(ws, `Waiting for at least ${room.min_players || 2} players with cards`);
          try {
            const result = await startGame(ws.roomId);
            if (result) {
              const calledNumbers = [];
              const cards = await getGameCards(ws.roomId, calledNumbers);
              broadcastToRoom(ws.roomId, 'gameStart', {
                roomId: ws.roomId,
                gameNumber: room.game_number,
                stake: Number(room.stake),
                totalCards: cards.length,
                prizePool: result.prizePool,
                calledNumbers,
                calledCount: 0,
                cards,
              });
            }
          } catch (e) { sendError(ws, e.message); }
          break;
        }

        case 'getGameState': {
          if (!ws.roomId) {
            send(ws, 'gameStateUpdate', { status: 'waiting', selectedCards: [], players: [] });
            break;
          }
          const snapshot = await roomSnapshot(ws.roomId);
          if (snapshot) {
            const selectedCards = snapshot.players.flatMap((p) => p.cards || []);
            const calledNumbers = Array.isArray(snapshot.called_numbers) ? snapshot.called_numbers : [];
            const cards = snapshot.state === 'PLAYING' ? await getGameCards(ws.roomId, calledNumbers) : [];
            send(ws, 'gameStateUpdate', {
              status: String(snapshot.state).toLowerCase(),
              roomId: snapshot.id, stake: Number(snapshot.stake), gameNumber: snapshot.game_number,
              selectedCards, calledNumbers, calledCount: calledNumbers.length,
              selectionTimeLeft: snapshot.state === 'SELECTING'
                ? Math.max(0, Math.ceil((new Date(snapshot.created_at).getTime() +
                    Number(snapshot.countdown_seconds || 60) * 1000 - Date.now()) / 1000))
                : 0,
              players: snapshot.players, cards,
            });
          }
          break;
        }

        case 'getLobbyData': { await broadcastLobbyData(); break; }

        case 'depositRequest': {
          const { userId, amount, method, phone } = data;
          const user = await findUser(userId || ws.userId);
          if (!user) return sendError(ws, 'User not found');
          const value = safeNumber(amount);
          if (value < 50 || value > 5000) return sendError(ws, 'Amount must be between 50 and 5000');
          if (!phone) return sendError(ws, 'Phone number required');
          try {
            const manualRef = 'manual-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
            const deposit = await pool.query(
              `INSERT INTO deposits (user_id, amount, method, reference, varify_reference, varify_status, status)
               VALUES ($1, $2, $3, $4, $5, 'MANUAL', 'PENDING') RETURNING *`,
              [user.id, value, method, manualRef, manualRef]
            );
            send(ws, 'depositStatus', { status: 'pending', deposit: deposit.rows[0] });
            await notification.sendAdminNotification(
              `💰 Deposit request\nUser: ${user.first_name} (${user.telegram_id})\nAmount: ${value} Birr\nMethod: ${method}\nPhone: ${phone}\nReference: ${manualRef}`
            );
          } catch (err) { sendError(ws, err.message || 'Deposit creation failed'); }
          break;
        }

        case 'withdrawRequest': {
          const { userId, amount, method, account } = data;
          const user = await findUser(userId || ws.userId);
          if (!user) return sendError(ws, 'User not found');
          const value = safeNumber(amount);
          if (value <= 0) return sendError(ws, 'Invalid amount');
          if (!account) return sendError(ws, 'Phone number required');
          const balanceResult = await pool.query(
            `SELECT balance, COALESCE(withdrawal_reserved, 0) AS withdrawal_reserved FROM users WHERE id = $1`, [user.id]
          );
          const balance = Number(balanceResult.rows[0].balance);
          const reserved = Number(balanceResult.rows[0].withdrawal_reserved || 0);
          if (balance - reserved < value) return sendError(ws, 'Insufficient balance');
          try {
            const client = await pool.connect();
            let withdrawal;
            try {
              await client.query('BEGIN');
              const manualRef = 'manual-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
              const wResult = await client.query(
                `INSERT INTO withdrawals (user_id, amount, method, destination, varify_reference, varify_status, status)
                 VALUES ($1, $2, $3, $4, $5, 'MANUAL', 'PENDING') RETURNING *`,
                [user.id, value, method || 'UNKNOWN', account, manualRef]
              );
              withdrawal = wResult.rows[0];
              await client.query(
                `UPDATE users SET withdrawal_reserved = COALESCE(withdrawal_reserved, 0) + $1 WHERE id = $2`,
                [value, user.id]
              );
              await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
            finally { client.release(); }
            send(ws, 'withdrawStatus', { status: 'pending', withdrawal });
            await notification.sendAdminNotification(
              `🏦 Withdrawal request\nUser: ${user.first_name} (${user.telegram_id})\nAmount: ${value} Birr\nMethod: ${method}\nAccount: ${account}\nReference: ${withdrawal.varify_reference}`
            );
          } catch (err) { sendError(ws, err.message || 'Withdrawal creation failed'); }
          break;
        }

        case 'transfer': {
          if (!ws.userId) return sendError(ws, 'Not authenticated');
          const recipient = await findUser(data.recipientId || data.phone);
          const amount = safeNumber(data.amount);
          if (!recipient) return sendError(ws, 'Recipient not found');
          if (String(recipient.id) === String(ws.userId)) return sendError(ws, 'Cannot transfer to yourself');
          if (amount <= 0) return sendError(ws, 'Invalid transfer amount');
          await wallet.transferBalance(ws.userId, recipient.id, amount);
          send(ws, 'transferResult', { success: true, amount, recipientId: String(recipient.id) });
          break;
        }

        case 'adminLogin': {
          const username = String(data.username || '').trim();
          const password = String(data.password || '');
          const expectedUsername = config.ADMIN_USERNAME;
          const passwordHash = config.ADMIN_PASSWORD_HASH;
          const adminTelegramId = config.ADMIN_TELEGRAM_ID;
          let valid = Boolean(expectedUsername && passwordHash && username === expectedUsername);
          if (valid) valid = await bcrypt.compare(password, passwordHash);
          const admin = valid ? await findUser(adminTelegramId) : null;
          if (admin?.is_admin) {
            ws.userId = String(admin.id);
            clients.set(ws.userId, ws);
            send(ws, 'adminAuth', { success: true });
            send(ws, 'adminData', { players: await getAdminPlayers() });
          } else {
            send(ws, 'adminAuth', { success: false });
          }
          break;
        }

        case 'getAdminData': {
          if (!ws.userId || !(await isAdmin(ws.userId))) return send(ws, 'adminAuth', { success: false });
          send(ws, 'adminData', { players: await getAdminPlayers() });
          break;
        }

        case 'adminAction': {
          if (!ws.userId || !(await isAdmin(ws.userId))) return sendError(ws, 'Admin authorization required');
          const admin = await findUser(ws.userId);
          const target = await findUser(data.playerId);
          if (!target) return sendError(ws, 'Player not found');
          const amount = safeNumber(data.amount);

          if (data.action === 'ban') {
            await pool.query(`UPDATE users SET is_banned = TRUE WHERE id = $1`, [target.id]);
            send(ws, 'adminActionResult', { success: true, action: data.action });
            send(ws, 'adminData', { players: await getAdminPlayers() });
            break;
          } else if (data.action === 'unban') {
            await pool.query(`UPDATE users SET is_banned = FALSE WHERE id = $1`, [target.id]);
            send(ws, 'adminActionResult', { success: true, action: data.action });
            send(ws, 'adminData', { players: await getAdminPlayers() });
            break;
          }
          if (amount <= 0) return sendError(ws, 'Invalid amount');

          if (data.action === 'deposit') {
            await wallet.adminAdjustBalance(admin.id, target.id, amount, 'ADMIN_DEPOSIT');
          } else if (data.action === 'withdraw') {
            await wallet.adminAdjustBalance(admin.id, target.id, -amount, 'ADMIN_WITHDRAW');
          } else if (data.action === 'transfer') {
            const recipient = await findUser(data.phone);
            if (!recipient) return sendError(ws, 'Recipient not found.');
            await wallet.transferBalance(target.id, recipient.id, amount);
          } else {
            return sendError(ws, 'Unknown admin action');
          }
          send(ws, 'adminActionResult', { success: true, action: data.action });
          send(ws, 'adminData', { players: await getAdminPlayers() });
          break;
        }

        default:
          sendError(ws, `Unknown command: ${type}`);
      }
    } catch (e) {
      console.error('WebSocket command error:', e);
      sendError(ws, e.message || 'Server error');
    }
  });

  ws.on('close', async () => {
    if (ws.userId) {
      clients.delete(ws.userId);
      try { await pool.query(`UPDATE users SET status = 'OFFLINE' WHERE id = $1`, [ws.userId]); } catch (_) {}
    }
  });
});

async function getAdminPlayers() {
  const result = await pool.query(
    `SELECT id, first_name AS name, username, balance, locked_balance,
            total_wins AS wins, total_games_played AS games, is_banned
     FROM users ORDER BY balance DESC LIMIT 500`
  );
  return result.rows.map((p) => ({
    ...p, balance: Number(p.balance), locked_balance: Number(p.locked_balance),
    wins: Number(p.wins || 0), games: Number(p.games || 0), is_banned: p.is_banned,
  }));
}

async function resumeActiveGames() {
  try {
    const rooms = await pool.query(`SELECT id FROM rooms WHERE state = 'PLAYING' AND status = 'PLAYING'`);
    for (const r of rooms.rows) startNumberCaller(r.id);
    if (rooms.rows.length) console.log(`♻️ Resumed ${rooms.rows.length} active game(s)`);
  } catch (e) { console.error('resumeActiveGames:', e); }
}

// ---------- 404 & Error Handling ----------
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
  next();
});
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(config.PORT, async () => {
  console.log('============================================================');
  console.log('🎯 M-BINGO MODULAR SERVER');
  console.log(`🌐 PORT: ${config.PORT}`);
  console.log('============================================================');
  await resumeActiveGames();
});

process.on('SIGTERM', async () => {
  for (const [roomId, timer] of roomTimers) { clearTimeout(timer); roomTimers.delete(roomId); }
  server.close(async () => { await pool.end(); process.exit(0); });
});

module.exports = { app, server, wss, pool };
