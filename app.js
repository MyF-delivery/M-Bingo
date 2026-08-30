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
const pool = require('./db'); // <-- shared pool with SSL
const wallet = require('./services/wallet');
const game = require('./services/game');
const notification = require('./services/notification');

const app = express();
app.disable('x-powered-by');
// ** FIXED: Trust proxy unconditionally to handle X-Forwarded-For header from Render**
// (If you want to allow it to be turned off, keep the env check but default it to true)
app.set('trust proxy', 1); 
const server = http.createServer(app);

// ---------- Middleware ----------
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
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'm-bingo', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
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
  } catch (e) {
    res.status(500).json({ error: 'Authorization error' });
  }
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
    return {
      valid: crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash)),
      reason: 'ok'
    };
  } catch (e) {
    return { valid: false, reason: 'invalid initData' };
  }
}

function validStake(stake) {
  const n = Number(stake);
  return Number.isFinite(n) && [10, 20, 30, 40, 50, 100].includes(n) ? n : null;
}

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

// ---------- API Routes ----------
app.post('/api/users/register', async (req, res) => {
  try {
    const { telegramId, username, firstName, lastName, photoUrl, telegramInitData } = req.body;
    if (!telegramId || !firstName)
      return res.status(400).json({ success: false, error: 'telegramId and firstName are required' });

    const telegramCheck = verifyTelegramWebAppInitData(telegramInitData);
    const browserTesting = config.ALLOW_BROWSER_TESTING;
    const botTokenHeader = String(req.headers['x-bot-token'] || '');
    const configuredBotToken = String(config.BOT_TOKEN || '');
    const botAuthorized = Boolean(configuredBotToken && botTokenHeader && botTokenHeader === configuredBotToken);

    if (!telegramCheck.valid && !browserTesting && !botAuthorized)
      return res.status(401).json({
        success: false,
        error: 'Telegram authentication is required',
        reason: telegramCheck.reason
      });

    if (telegramCheck.valid && !botAuthorized) {
      const params = new URLSearchParams(telegramInitData);
      const tgUser = JSON.parse(params.get('user') || '{}');
      if (String(tgUser.id) !== String(telegramId))
        return res.status(401).json({ success: false, error: 'Telegram user mismatch' });
    }

    const existing = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
    if (existing.rows.length) {
      await pool.query(
        `UPDATE users
         SET username = COALESCE($2, username),
             first_name = COALESCE($3, first_name),
             last_name = COALESCE($4, last_name),
             photo_url = COALESCE($5, photo_url),
             last_login = CURRENT_TIMESTAMP
         WHERE telegram_id = $1`,
        [telegramId, username || null, firstName || null, lastName || null, photoUrl || null]
      );
      const updated = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
      return res.json({ success: true, user: updated.rows[0], message: 'User already exists' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        `INSERT INTO users
         (telegram_id, username, first_name, last_name, photo_url, balance, last_login)
         VALUES ($1, $2, $3, $4, $5, 50, CURRENT_TIMESTAMP)
         RETURNING *`,
        [telegramId, username || '', firstName, lastName || '', photoUrl || null]
      );
      const user = userResult.rows[0];
      await wallet.addLedger(client, user.id, 'SIGNUP_BONUS', 50, 0, 50, 'USER', user.id);
      await client.query('COMMIT');
      res.json({ success: true, user, message: 'User registered with 50 Birr bonus!' });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ADDED: Missing route for checking users by ID or Telegram ID
app.get('/api/users/:userId', async (req, res) => {
  try {
    const user = await findUser(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({
      success: true,
      user: {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        balance: Number(user.balance),
        gamesPlayed: Number(user.total_games_played || 0),
        wins: Number(user.total_wins || 0),
        createdAt: user.created_at
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const user = await findUser(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      first_name: user.first_name,
      username: user.username,
      balance: Number(user.balance),
      locked_balance: Number(user.locked_balance),
      withdrawal_reserved: Number(user.withdrawal_reserved || 0),
      available_balance: Math.max(0, Number(user.balance) - Number(user.withdrawal_reserved || 0)),
      total_wins: Number(user.total_wins || 0),
      total_games_played: Number(user.total_games_played || 0),
      total_winnings: Number(user.total_winnings || 0)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cards', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT card_number, board FROM bingo_cards WHERE is_active = TRUE ORDER BY card_number LIMIT 200`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.stake, r.status, r.state, r.prize_pool, r.game_number,
              COUNT(rp.id)::int AS player_count
       FROM rooms r
       LEFT JOIN room_players rp ON rp.room_id = r.id AND rp.left_at IS NULL
       WHERE r.state <> 'ENDED'
       GROUP BY r.id
       ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users/by-username/:username', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM users WHERE username ILIKE $1`, [username]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/transfer', async (req, res) => {
  const { fromId, toId, amount } = req.body;
  try {
    await wallet.transferBalance(fromId, toId, amount);
    res.json({ success: true, message: 'Transfer successful' });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/deposit/request', async (req, res) => {
  const { userId, amount, method, txnId } = req.body;
  const user = await findUser(userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  const value = safeNumber(amount);
  if (value < 50 || value > 5000)
    return res.status(400).json({ success: false, message: 'Amount must be between 50 and 5000' });
  try {
    const result = await pool.query(
      `INSERT INTO deposits (user_id, amount, method, reference, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING *`,
      [user.id, value, method || 'UNKNOWN', txnId || null]
    );
    await notification.sendAdminNotification(
      `💰 New Deposit Request!\nUser: ${user.first_name} (${user.telegram_id})\nAmount: ${value} Birr\nMethod: ${method}\nTxn: ${txnId}\nStatus: Pending Approval`
    );
    res.json({ success: true, deposit: result.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/withdraw/request', async (req, res) => {
  const { userId, amount, method, account } = req.body;
  const user = await findUser(userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  const value = safeNumber(amount);
  if (value <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

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
    const result = await client.query(
      `INSERT INTO withdrawals (user_id, amount, method, destination, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING *`,
      [user.id, value, method || 'UNKNOWN', account]
    );
    await client.query(
      `UPDATE users SET withdrawal_reserved = COALESCE(withdrawal_reserved, 0) + $1 WHERE id = $2`,
      [value, user.id]
    );
    await client.query('COMMIT');
    await notification.sendAdminNotification(
      `🏦 New Withdrawal Request!\nUser: ${user.first_name} (${user.telegram_id})\nAmount: ${value} Birr\nMethod: ${method}\nAccount: ${account}\nStatus: Pending Approval`
    );
    res.json({ success: true, withdrawal: result.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, message: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/referral/process', async (req, res) => {
  const { referrerId, newUserId } = req.body;
  const referrer = await findUser(referrerId);
  const newUser = await findUser(newUserId);
  if (!referrer || !newUser) return res.status(404).json({ success: false, message: 'User not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT * FROM referrals WHERE referrer_id = $1 AND referred_id = $2`,
      [referrer.id, newUser.id]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Referral already processed' });
    }

    const referrerBalance = await client.query(
      `SELECT balance FROM users WHERE id = $1 FOR UPDATE`,
      [referrer.id]
    );
    const before = Number(referrerBalance.rows[0].balance);
    const after = before + config.REFERRAL_BONUS;

    await client.query(`UPDATE users SET balance = $1 WHERE id = $2`, [after, referrer.id]);
    await wallet.addLedger(
      client,
      referrer.id,
      'REFERRAL_BONUS',
      config.REFERRAL_BONUS,
      before,
      after,
      'REFERRAL',
      newUser.id
    );
    await client.query(
      `INSERT INTO referrals (referrer_id, referred_id, bonus_amount, status, paid_at)
       VALUES ($1, $2, $3, 'PAID', CURRENT_TIMESTAMP)`,
      [referrer.id, newUser.id, config.REFERRAL_BONUS]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, message: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/action', requireAdmin, async (req, res) => {
  const { adminId, action, playerId, amount } = req.body;
  const target = await findUser(playerId);
  if (!target) return res.status(404).json({ error: 'Player not found' });
  const value = safeNumber(amount);
  try {
    if (action === 'ban') {
      await pool.query(`UPDATE users SET is_banned = TRUE WHERE id = $1`, [target.id]);
      return res.json({ success: true, message: 'User banned' });
    } else if (action === 'unban') {
      await pool.query(`UPDATE users SET is_banned = FALSE WHERE id = $1`, [target.id]);
      return res.json({ success: true, message: 'User unbanned' });
    }
    if (value <= 0) return res.status(400).json({ error: 'Invalid amount' });

    if (action === 'deposit') {
      await wallet.adminAdjustBalance(req.admin.id, target.id, value, 'ADMIN_DEPOSIT');
      const newBalance = (await pool.query(`SELECT balance FROM users WHERE id=$1`, [target.id])).rows[0].balance;
      res.json({ success: true, newBalance });
    } else if (action === 'withdraw') {
      await wallet.adminAdjustBalance(req.admin.id, target.id, -value, 'ADMIN_WITHDRAW');
      const newBalance = (await pool.query(`SELECT balance FROM users WHERE id=$1`, [target.id])).rows[0].balance;
      res.json({ success: true, newBalance });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/user/:userId', requireAdmin, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, telegram_id, first_name, username, balance, locked_balance,
              withdrawal_reserved, total_wins, total_games_played, total_winnings,
              is_admin, is_banned, created_at, last_login
       FROM users WHERE id = $1`,
      [req.params.userId]
    );
    if (!userResult.rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const txResult = await pool.query(
      `SELECT type, amount, balance_before, balance_after, created_at
       FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.userId]
    );
    res.json({ success: true, user: userResult.rows[0], transactions: txResult.rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/admin/data', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name AS name, username, telegram_id, balance, locked_balance,
              total_wins AS wins, total_games_played AS games, is_banned
       FROM users ORDER BY balance DESC LIMIT 500`
    );
    res.json({ success: true, players: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
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
    if (!adminUser) return res.status(404).json({ success: false, message: 'Admin user not found in database' });
    if (adminUser.is_admin !== true) return res.status(403).json({ success: false, message: 'User is not an admin' });
    res.json({ success: true, adminId: adminUser.id });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT d.*, u.first_name AS "userName", u.telegram_id AS "userId"
     FROM deposits d JOIN users u ON u.id = d.user_id
     WHERE d.status = 'PENDING'
     ORDER BY d.created_at DESC`
  );
  res.json(result.rows);
});

app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT w.*, u.first_name AS "userName", u.telegram_id AS "userId"
     FROM withdrawals w JOIN users u ON u.id = w.user_id
     WHERE w.status = 'PENDING'
     ORDER BY w.created_at DESC`
  );
  res.json(result.rows);
});

app.post('/api/admin/deposits/approve', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dep = await client.query(
      `SELECT * FROM deposits WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
      [req.body.depositId]
    );
    if (!dep.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }); }
    const d = dep.rows[0];
    const user = await client.query(
      `SELECT balance, COALESCE(withdrawal_reserved, 0) AS withdrawal_reserved FROM users WHERE id = $1 FOR UPDATE`,
      [d.user_id]
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
  } finally {
    client.release();
  }
});

app.post('/api/admin/deposits/reject', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dep = await client.query(
      `SELECT * FROM deposits WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
      [req.body.depositId]
    );
    if (!dep.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }); }
    await client.query(
      `UPDATE deposits
       SET status = 'REJECTED', admin_id = $1, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $2
       WHERE id = $3`,
      [req.admin.id, String(req.body.reason || 'Rejected by admin'), dep.rows[0].id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/withdrawals/approve', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wr = await client.query(
      `SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
      [req.body.withdrawalId]
    );
    if (!wr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Withdrawal not found' }); }
    const w = wr.rows[0];
    const user = await client.query(
      `SELECT balance, COALESCE(withdrawal_reserved, 0) AS withdrawal_reserved FROM users WHERE id = $1 FOR UPDATE`,
      [w.user_id]
    );
    const before = Number(user.rows[0].balance);
    if (before < Number(w.amount)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }); }
    const after = before - Number(w.amount);
    await client.query(
      `UPDATE users
       SET balance = $1,
           withdrawal_reserved = GREATEST(0, COALESCE(withdrawal_reserved, 0) - $2)
       WHERE id = $3`,
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
  } finally {
    client.release();
  }
});

app.post('/api/admin/withdrawals/reject', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wr = await client.query(
      `SELECT * FROM withdrawals WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
      [req.body.withdrawalId]
    );
    if (!wr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Withdrawal not found' }); }
    const w = wr.rows[0];
    await client.query(
      `UPDATE users
       SET withdrawal_reserved = GREATEST(0, COALESCE(withdrawal_reserved, 0) - $1)
       WHERE id = $2`,
      [Number(w.amount), w.user_id]
    );
    await client.query(
      `UPDATE withdrawals
       SET status = 'REJECTED', admin_id = $1, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $2
       WHERE id = $3`,
      [req.admin.id, String(req.body.reason || 'Rejected by admin'), w.id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/balance/add', requireAdmin, async (req, res) => {
  try {
    await wallet.adminAdjustBalance(req.admin.id, req.body.userId, safeNumber(req.body.amount), 'ADMIN_DEPOSIT');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/balance/remove', requireAdmin, async (req, res) => {
  try {
    await wallet.adminAdjustBalance(req.admin.id, req.body.userId, -safeNumber(req.body.amount), 'ADMIN_WITHDRAW');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocket.Server({
  server,
  verifyClient: (info) => {
    console.log('🔌 WebSocket connection attempt from:', info.origin);
    return true; // Accept all origins (for debugging)
  }
});
console.log('✅ WebSocket server attached to HTTP server');

const clients = new Map();

function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}
function sendError(ws, message) {
  send(ws, 'gameError', { message });
}
function broadcastToRoom(roomId, type, data) {
  for (const ws of clients.values()) {
    if (ws.roomId === roomId) send(ws, type, data);
  }
}

// Override game's broadcast functions
game.broadcastToRoom = broadcastToRoom;

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
          if (user.is_banned === true) return sendError(ws, 'You are banned from playing. Contact Admin.');
          ws.userId = String(user.id);
          clients.set(ws.userId, ws);
          await pool.query(`UPDATE users SET status = 'ONLINE', last_login = CURRENT_TIMESTAMP WHERE id = $1`, [
            user.id,
          ]);
          const active = await pool.query(
            `SELECT rp.room_id
             FROM room_players rp
             JOIN rooms r ON r.id = rp.room_id
             WHERE rp.user_id = $1 AND rp.left_at IS NULL AND r.state IN ('SELECTING', 'PLAYING')
             ORDER BY rp.joined_at DESC LIMIT 1`,
            [user.id]
          );
          if (active.rows.length) ws.roomId = active.rows[0].room_id;
          const snapshot = ws.roomId ? await game.roomSnapshot(ws.roomId) : null;
          send(ws, 'init', {
            playerId: String(user.id),
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
            const cards = await game.getGameCards(ws.roomId, snapshot.called_numbers || []);
            send(ws, 'gameStart', {
              roomId: ws.roomId,
              gameNumber: snapshot.game_number,
              stake: Number(snapshot.stake),
              totalCards: cards.length,
              prizePool: Number(snapshot.prize_pool),
              cards,
            });
          }
          break;
        }

        case 'startSelection': {
          const user = await findUser(data.userId || ws.userId);
          const stake = validStake(data.stake);
          if (!user) return sendError(ws, 'Please register/login first');
          if (user.is_banned === true) return sendError(ws, 'You are banned from playing.');
          if (!stake) return sendError(ws, 'Invalid stake. Choose 10, 20, 30, 40, 50 or 100 Birr');

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const room = await game.findOrCreateRoom(client, user.id, stake);
            const joined = await client.query(
              `SELECT id FROM room_players WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL FOR UPDATE`,
              [room.id, user.id]
            );
            if (!joined.rows.length) {
              await client.query(
                `INSERT INTO room_players (room_id, user_id, cards, is_ready)
                 VALUES ($1, $2, '[]'::jsonb, FALSE)`,
                [room.id, user.id]
              );
            }
            await client.query(`UPDATE rooms SET status = 'SELECTING', state = 'SELECTING' WHERE id = $1`, [room.id]);
            await client.query('COMMIT');
            ws.userId = String(user.id);
            ws.roomId = room.id;
            clients.set(ws.userId, ws);
            game.scheduleSelectionTimeout(room.id, Number(room.countdown_seconds || config.BINGO_SELECTION_SECONDS));
            const snapshot = await game.roomSnapshot(room.id);
            if (snapshot) {
              const selectedCards = snapshot.players.flatMap((p) => p.cards || []);
              broadcastToRoom(room.id, 'gameStateUpdate', {
                status: 'selecting',
                roomId: room.id,
                stake: Number(snapshot.stake),
                gameNumber: snapshot.game_number,
                selectedCards,
                selectionTimeLeft: Number(room.countdown_seconds || config.BINGO_SELECTION_SECONDS),
                players: snapshot.players,
              });
            }
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            sendError(ws, e.message);
          } finally {
            client.release();
          }
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
              `SELECT card_number, board FROM bingo_cards WHERE card_number = $1 AND is_active = TRUE`,
              [cardNumber]
            );
            if (!cardResult.rows.length) throw new Error('Card not found');

            const used = await client.query(
              `SELECT user_id, cards FROM room_players WHERE room_id = $1 AND left_at IS NULL FOR UPDATE`,
              [ws.roomId]
            );
            for (const p of used.rows) {
              const cards = Array.isArray(p.cards) ? p.cards.map(Number) : [];
              if (cards.includes(cardNumber)) throw new Error('This card is already selected');
            }
            const me = used.rows.find((p) => String(p.user_id) === String(ws.userId));
            if (!me) throw new Error('You are not in this room');
            const myCards = Array.isArray(me.cards) ? me.cards.map(Number) : [];
            if (myCards.length >= 5) throw new Error('Maximum 5 cards allowed');
            if (myCards.includes(cardNumber)) throw new Error('You already selected this card');
            myCards.push(cardNumber);

            await client.query(
              `UPDATE room_players SET cards = $1::jsonb WHERE room_id = $2 AND user_id = $3`,
              [JSON.stringify(myCards), ws.roomId, ws.userId]
            );
            await client.query('COMMIT');
            send(ws, 'cardSelectionResult', { success: true, cardNumber, cards: myCards });
            const snapshot = await game.roomSnapshot(ws.roomId);
            if (snapshot) {
              const selectedCards = snapshot.players.flatMap((p) => p.cards || []);
              broadcastToRoom(ws.roomId, 'gameStateUpdate', {
                status: 'selecting',
                roomId: ws.roomId,
                stake: Number(snapshot.stake),
                gameNumber: snapshot.game_number,
                selectedCards,
                selectionTimeLeft:
                  snapshot.state === 'SELECTING'
                    ? Math.max(
                        0,
                        Math.ceil(
                          (new Date(snapshot.created_at).getTime() +
                            Number(snapshot.countdown_seconds || config.BINGO_SELECTION_SECONDS) * 1000 -
                            Date.now()) /
                            1000
                        )
                      )
                    : 0,
                players: snapshot.players,
              });
            }
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            send(ws, 'cardSelectionResult', { success: false, message: e.message });
          } finally {
            client.release();
          }
          break;
        }

        case 'startGame': {
          if (!ws.userId || !ws.roomId) return sendError(ws, 'Join a game first');
          const room = await game.roomSnapshot(ws.roomId);
          if (!room) return sendError(ws, 'Room not found');
          const readyPlayers = room.players.filter((p) => Array.isArray(p.cards) && p.cards.length);
          if (readyPlayers.length < Number(room.min_players || 2))
            return sendError(ws, `Waiting for at least ${room.min_players || 2} players with cards`);
          const result = await game.startGame(ws.roomId);
          if (result) {
            broadcastToRoom(ws.roomId, 'gameStart', result);
          }
          break;
        }

        case 'getGameState': {
          if (!ws.roomId) {
            send(ws, 'gameStateUpdate', { status: 'waiting', selectedCards: [], players: [] });
            break;
          }
          const snapshot = await game.roomSnapshot(ws.roomId);
          if (snapshot) {
            const selectedCards = snapshot.players.flatMap((p) => p.cards || []);
            send(ws, 'gameStateUpdate', {
              status: String(snapshot.state).toLowerCase(),
              roomId: snapshot.id,
              stake: Number(snapshot.stake),
              gameNumber: snapshot.game_number,
              selectedCards,
              selectionTimeLeft:
                snapshot.state === 'SELECTING'
                  ? Math.max(
                      0,
                      Math.ceil(
                        (new Date(snapshot.created_at).getTime() +
                          Number(snapshot.countdown_seconds || config.BINGO_SELECTION_SECONDS) * 1000 -
                          Date.now()) /
                          1000
                      )
                    )
                  : 0,
              players: snapshot.players,
            });
          }
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
            if (!recipient) return sendError(ws, 'Recipient not found. Enter recipient Telegram ID.');
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
      try {
        await pool.query(`UPDATE users SET status = 'OFFLINE' WHERE id = $1`, [ws.userId]);
      } catch (_) {}
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
    ...p,
    balance: Number(p.balance),
    locked_balance: Number(p.locked_balance),
    wins: Number(p.wins || 0),
    games: Number(p.games || 0),
    is_banned: p.is_banned,
  }));
}

async function resumeActiveGames() {
  try {
    const rooms = await pool.query(`SELECT id FROM rooms WHERE state = 'PLAYING' AND status = 'PLAYING'`);
    for (const r of rooms.rows) {
      game.startNumberCaller(r.id);
    }
    if (rooms.rows.length) console.log(`♻️ Resumed ${rooms.rows.length} active game(s)`);
  } catch (e) {
    console.error('resumeActiveGames:', e);
  }
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

// ---------- Start Server ----------
server.listen(config.PORT, async () => {
  console.log('============================================================');
  console.log('🎯 M-BINGO MODULAR SERVER');
  console.log(`🌐 PORT: ${config.PORT}`);
  console.log(`⏱️ CALL INTERVAL: ${config.BINGO_CALL_INTERVAL_MS} ms`);
  console.log('============================================================');
  await resumeActiveGames();
});

process.on('SIGTERM', async () => {
  for (const roomId of game.roomTimers.keys()) game.stopNumberCaller(roomId);
  for (const roomId of game.selectionTimers.keys()) game.clearSelectionTimer(roomId);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});

module.exports = { app, server, wss, pool };