// ============================================================
// M-BINGO PRODUCTION SERVER - FIXED GAME ENGINE V3
// Built for schema(2).sql
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const WebSocket = require('ws');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
const server = http.createServer(app);

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

const PORT = process.env.PORT || 3000;
const ALLOWED_STAKES = [10, 20, 30, 40, 50, 100];
const DEFAULT_CALL_INTERVAL = Number(process.env.BINGO_CALL_INTERVAL_MS || 10000);
const DEFAULT_SELECTION_SECONDS = Number(process.env.BINGO_SELECTION_SECONDS || 60);
const MIN_PLAYERS_DEFAULT = Number(process.env.BINGO_MIN_PLAYERS || 2);
const REFERRAL_BONUS = 20; // Birr per successful referral

app.use(helmet());
app.use(compression());
app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : true,
    credentials: false
}));
app.use(express.json({ limit: '256kb' }));
app.use((req,res,next)=>{ res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); next(); });

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', limiter);

app.get('/', (req, res) => {
    res.json({
        ok: true,
        service: 'm-bingo',
        status: 'online',
        websocket: true,
        health: '/health',
        version: '3.1.0'
    });
});

app.get('/ready', async (req,res)=>{ try { await pool.query('SELECT 1'); res.json({ok:true}); } catch(e){ res.status(503).json({ok:false}); } });

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ ok: true, service: 'm-bingo', time: new Date().toISOString() });
    } catch (e) {
        res.status(503).json({ ok: false, error: 'database unavailable' });
    }
});

async function findUser(idOrTelegram) {
    const value = String(idOrTelegram || '');
    if (!value) return null;

    let result = await pool.query(
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
        console.error('Admin authorization error:', e);
        res.status(500).json({ error: 'Authorization error' });
    }
}

function verifyTelegramWebAppInitData(initData) {
    if (!initData) return { valid: false, reason: 'missing initData' };
    const botToken = process.env.BOT_TOKEN;
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
        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();

        const calculated = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

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
    return Number.isFinite(n) && ALLOWED_STAKES.includes(n) ? n : null;
}

function safeNumber(n) {
    const x = Number(n);
    return Number.isFinite(x) ? x : 0;
}

async function addLedger(client, userId, type, amount, before, after, referenceType = null, referenceId = null) {
    await client.query(
        `INSERT INTO wallet_transactions
         (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [userId, type, amount, before, after, referenceType, referenceId]
    );
}

function shuffled75() {
    const a = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function normalizeBoard(board) {
    return Array.isArray(board) ? board : [];
}

function checkPatterns(board, calledSet) {
    const b = normalizeBoard(board);
    if (b.length !== 5 || !b.every(row => Array.isArray(row) && row.length === 5)) return [];

    const marked = b.map(row => row.map(v => v === 0 || calledSet.has(Number(v))));

    const patterns = [];

    for (let r = 0; r < 5; r++) {
        if (marked[r].every(Boolean)) patterns.push({ type: 'row', index: r, label: `Row ${r + 1}` });
    }

    for (let c = 0; c < 5; c++) {
        let ok = true;
        for (let r = 0; r < 5; r++) if (!marked[r][c]) ok = false;
        if (ok) patterns.push({ type: 'column', index: c, label: `Column ${c + 1}` });
    }

    if ([0,1,2,3,4].every(i => marked[i][i])) {
        patterns.push({ type: 'diagonal', index: 0, label: 'Diagonal ↘' });
    }
    if ([0,1,2,3,4].every(i => marked[i][4-i])) {
        patterns.push({ type: 'diagonal', index: 1, label: 'Diagonal ↙' });
    }

    if (marked[0][0] && marked[0][4] && marked[4][0] && marked[4][4]) {
        patterns.push({ type: 'corner', index: 0, label: 'Corners' });
    }

    return patterns;
}

function markedBoard(board, calledSet) {
    return normalizeBoard(board).map(row =>
        row.map(v => v === 0 || calledSet.has(Number(v)))
    );
}

const wss = new WebSocket.Server({ server });
const clients = new Map(); // user UUID -> ws
const roomTimers = new Map(); // room UUID -> interval
const selectionTimers = new Map(); // room UUID -> timeout

function send(ws, type, data = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, data }));
    }
}

function sendError(ws, message) {
    send(ws, 'gameError', { message });
}

function broadcastToRoom(roomId, type, data) {
    for (const ws of clients.values()) {
        if (ws.roomId === roomId) send(ws, type, data);
    }
}

async function roomSnapshot(roomId) {
    const roomResult = await pool.query(
        `SELECT id, stake, status, state, min_players, max_players,
                countdown_seconds, calling_interval_ms, winning_pattern,
                prize_pool, game_number, called_numbers, current_call_index, created_at
         FROM rooms WHERE id = $1`,
        [roomId]
    );
    if (!roomResult.rows.length) return null;

    const room = roomResult.rows[0];
    const playersResult = await pool.query(
        `SELECT rp.user_id AS id,
                u.first_name AS name,
                u.username,
                u.balance,
                rp.cards,
                rp.is_ready,
                rp.is_winner,
                rp.winning_amount
         FROM room_players rp
         JOIN users u ON u.id = rp.user_id
         WHERE rp.room_id = $1 AND rp.left_at IS NULL
         ORDER BY rp.joined_at`,
        [roomId]
    );

    return {
        ...room,
        players: playersResult.rows.map(p => ({
            ...p,
            cards: Array.isArray(p.cards) ? p.cards : []
        }))
    };
}

async function broadcastRoomState(roomId) {
    const room = await roomSnapshot(roomId);
    if (!room) return;

    const now = Date.now();
    let selectionTimeLeft = 0;
    if (room.state === 'SELECTING' && room.created_at) {
        const end = new Date(room.created_at).getTime() + Number(room.countdown_seconds || DEFAULT_SELECTION_SECONDS) * 1000;
        selectionTimeLeft = Math.max(0, Math.ceil((end - now) / 1000));
    }

    const selectedCards = [];
    room.players.forEach(p => (p.cards || []).forEach(card => selectedCards.push(Number(card))));

    broadcastToRoom(roomId, 'gameStateUpdate', {
        status: String(room.state || room.status || 'WAITING').toLowerCase(),
        roomId: room.id,
        stake: Number(room.stake),
        gameNumber: room.game_number,
        selectedCards,
        selectionTimeLeft,
        players: room.players
    });
}

async function findOrCreateRoom(client, userId, stake) {
    const existing = await client.query(
        `SELECT r.*
         FROM rooms r
         WHERE r.stake = $1
           AND r.state IN ('WAITING','SELECTING')
           AND r.status IN ('WAITING','SELECTING')
           AND (
               SELECT COUNT(*) FROM room_players rp
               WHERE rp.room_id = r.id AND rp.left_at IS NULL
           ) < r.max_players
           AND NOT EXISTS (
               SELECT 1 FROM room_players mine
               WHERE mine.room_id = r.id AND mine.user_id = $2 AND mine.left_at IS NULL
           )
         ORDER BY r.created_at ASC
         LIMIT 1
         FOR UPDATE`,
        [stake, userId]
    );

    if (existing.rows.length) return existing.rows[0];

    const created = await client.query(
        `INSERT INTO rooms
         (stake, max_players, min_players, status, state,
          countdown_seconds, calling_interval_ms, winning_pattern,
          prize_pool, game_number, number_sequence, called_numbers, current_call_index)
         VALUES ($1,100,$2,'WAITING','SELECTING',$3,$4,'ANY',0,0,'[]'::jsonb,'[]'::jsonb,0)
         RETURNING *`,
        [stake, MIN_PLAYERS_DEFAULT, DEFAULT_SELECTION_SECONDS, DEFAULT_CALL_INTERVAL]
    );

    return created.rows[0];
}

async function chargeStake(client, userId, roomId, stake, cardCount) {
    const userResult = await client.query(
        `SELECT id, balance, locked_balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
    );
    if (!userResult.rows.length) throw new Error('User not found');

    const user = userResult.rows[0];
    const balance = Number(user.balance);
    const locked = Number(user.locked_balance);
    const reserved = Number(user.withdrawal_reserved || 0);
    
    const totalCost = stake * cardCount;

    if (balance - reserved < totalCost) {
        throw new Error(`Insufficient available balance. You need ${totalCost} Birr for ${cardCount} cards.`);
    }

    const newBalance = balance - totalCost;
    const newLocked = locked + totalCost;

    await client.query(
        `UPDATE users SET balance = $1, locked_balance = $2, last_login = CURRENT_TIMESTAMP WHERE id = $3`,
        [newBalance, newLocked, userId]
    );

    await addLedger(client, userId, 'STAKE_LOCK', totalCost, balance, newBalance, 'ROOM', roomId);
}

async function releaseStake(client, userId, roomId, refund = false, amount = null) {
    const result = await client.query(
        `SELECT balance, locked_balance FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
    );
    if (!result.rows.length) return;
    const u = result.rows[0];
    const locked = Number(u.locked_balance);
    const releaseAmount = Math.max(0, Math.min(locked, Number(amount ?? 0)));
    if (releaseAmount <= 0) return;
    const before = Number(u.balance);
    if (refund) {
        const after = before + releaseAmount;
        await client.query(`UPDATE users SET balance=$1, locked_balance=GREATEST(0,locked_balance-$2) WHERE id=$3`, [after, releaseAmount, userId]);
        await addLedger(client, userId, 'STAKE_REFUND', releaseAmount, before, after, 'ROOM', roomId);
    } else {
        await client.query(`UPDATE users SET locked_balance=GREATEST(0,locked_balance-$1) WHERE id=$2`, [releaseAmount, userId]);
    }
}

async function startGame(roomId) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const roomResult = await client.query(
            `SELECT * FROM rooms WHERE id = $1 FOR UPDATE`,
            [roomId]
        );
        if (!roomResult.rows.length) throw new Error('Room not found');

        const room = roomResult.rows[0];
        if (room.state === 'PLAYING') {
            await client.query('COMMIT');
            return;
        }

        const rpResult = await client.query(
            `SELECT rp.user_id, rp.cards
             FROM room_players rp
             WHERE rp.room_id = $1 AND rp.left_at IS NULL
             FOR UPDATE`,
            [roomId]
        );

        if (rpResult.rows.length < Number(room.min_players || 2)) {
            await client.query('ROLLBACK');
            return false;
        }

        const activePlayers = rpResult.rows.filter(p => Array.isArray(p.cards) && p.cards.length > 0);
        if (activePlayers.length < Number(room.min_players || 2)) {
            await client.query('ROLLBACK');
            return false;
        }

        let totalStake = 0;
        for (const p of activePlayers) {
            const cardCount = p.cards.length;
            const totalCost = Number(room.stake) * cardCount;
            totalStake += totalCost;
            await chargeStake(client, p.user_id, roomId, Number(room.stake), cardCount);
        }

        const sequence = shuffled75();
        const gameNumber = Number(room.game_number || 0) + 1;
        const totalPlayers = activePlayers.length;
        const prizePool = Math.round(totalStake * 0.70 * 100) / 100;

        await client.query(
            `UPDATE rooms
             SET status='PLAYING',
                 state='PLAYING',
                 game_number=$2,
                 number_sequence=$3::jsonb,
                 current_call_index=0,
                 called_numbers='[]'::jsonb,
                 prize_pool=$4,
                 started_at=CURRENT_TIMESTAMP,
                 ended_at=NULL
             WHERE id=$1`,
            [roomId, gameNumber, JSON.stringify(sequence), prizePool]
        );

        await client.query(
            `UPDATE room_players SET is_ready=TRUE WHERE room_id=$1 AND left_at IS NULL`,
            [roomId]
        );

        await client.query('COMMIT');

        clearSelectionTimer(roomId);

        const full = await roomSnapshot(roomId);
        const cards = await getGameCards(roomId, []);

        broadcastToRoom(roomId, 'gameStart', {
            roomId,
            gameNumber,
            stake: Number(full.stake),
            totalCards: cards.length,
            totalPlayers: activePlayers.length,
            prizePool,
            cards
        });

        startNumberCaller(roomId);
        return true;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('startGame:', e);
        broadcastToRoom(roomId, 'gameError', { message: e.message });
        return false;
    } finally {
        client.release();
    }
}

async function getGameCards(roomId, calledNumbers) {
    const calledSet = new Set(calledNumbers.map(Number));

    const result = await pool.query(
        `SELECT rp.user_id, rp.cards, u.first_name AS player_name
         FROM room_players rp
         JOIN users u ON u.id=rp.user_id
         WHERE rp.room_id=$1 AND rp.left_at IS NULL`,
        [roomId]
    );

    const allCardNumbers = [];
    const ownerMap = new Map();

    for (const p of result.rows) {
        for (const cardNumber of (Array.isArray(p.cards) ? p.cards : [])) {
            allCardNumbers.push(Number(cardNumber));
            ownerMap.set(Number(cardNumber), { playerId: String(p.user_id), playerName: p.player_name || 'Player' });
        }
    }

    if (!allCardNumbers.length) return [];

    const cardsResult = await pool.query(
        `SELECT card_number, board
         FROM bingo_cards
         WHERE card_number = ANY($1::int[])
         ORDER BY card_number`,
        [allCardNumbers]
    );

    return cardsResult.rows.map(c => ({
        playerId: ownerMap.get(Number(c.card_number))?.playerId,
        playerName: ownerMap.get(Number(c.card_number))?.playerName || 'Player',
        cardNumber: Number(c.card_number),
        board: c.board,
        marked: markedBoard(c.board, calledSet)
    }));
}

async function callNextNumber(roomId) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `SELECT * FROM rooms WHERE id=$1 FOR UPDATE`,
            [roomId]
        );

        if (!result.rows.length) {
            await client.query('ROLLBACK');
            stopNumberCaller(roomId);
            return;
        }

        const room = result.rows[0];

        if (room.state !== 'PLAYING') {
            await client.query('ROLLBACK');
            stopNumberCaller(roomId);
            return;
        }

        const sequence = Array.isArray(room.number_sequence) ? room.number_sequence : [];
        const called = Array.isArray(room.called_numbers) ? room.called_numbers.map(Number) : [];
        const index = Number(room.current_call_index || 0);

        if (index >= sequence.length) {
            await client.query('COMMIT');
            await finishRoomNoWinner(roomId);
            return;
        }

        const number = Number(sequence[index]);
        const newCalled = [...called, number];

        await client.query(
            `UPDATE rooms
             SET called_numbers=$2::jsonb, current_call_index=$3
             WHERE id=$1`,
            [roomId, JSON.stringify(newCalled), index + 1]
        );

        await client.query('COMMIT');

        const cards = await getGameCards(roomId, newCalled);
        broadcastToRoom(roomId, 'numberCalled', {
            number,
            letter: number <= 15 ? 'B' : number <= 30 ? 'I' : number <= 45 ? 'N' : number <= 60 ? 'G' : 'O',
            calledNumbers: newCalled,
            calledCount: newCalled.length
        });

        const winners = [];

        for (const card of cards) {
            const patterns = checkPatterns(card.board, new Set(newCalled));
            if (patterns.length) {
                winners.push({
                    playerId: card.playerId,
                    cardNumber: card.cardNumber,
                    patterns
                });
            }
        }

        if (winners.length) {
            await finishRoomWithWinners(roomId, winners, newCalled);
        } else if (newCalled.length >= 75) {
            await finishRoomNoWinner(roomId);
        }
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('callNextNumber:', e);
    } finally {
        client.release();
    }
}

function startNumberCaller(roomId) {
    stopNumberCaller(roomId);

    const timer = setInterval(() => {
        callNextNumber(roomId).catch(err => console.error(err));
    }, DEFAULT_CALL_INTERVAL);

    roomTimers.set(roomId, timer);

    setTimeout(() => callNextNumber(roomId).catch(err => console.error(err)), 500);
}

function stopNumberCaller(roomId) {
    const timer = roomTimers.get(roomId);
    if (timer) clearInterval(timer);
    roomTimers.delete(roomId);
}

function clearSelectionTimer(roomId) {
    const timer = selectionTimers.get(roomId);
    if (timer) clearTimeout(timer);
    selectionTimers.delete(roomId);
}

function scheduleSelectionTimeout(roomId, seconds) {
    clearSelectionTimer(roomId);

    const timer = setTimeout(async () => {
        try {
            const snapshot = await roomSnapshot(roomId);
            if (!snapshot || snapshot.state !== 'SELECTING') return;

            const playersWithCards = snapshot.players.filter(p => Array.isArray(p.cards) && p.cards.length);
            if (playersWithCards.length >= Number(snapshot.min_players || 2)) {
                await startGame(roomId);
            } else {
                await cancelRoomAndRefund(roomId, 'Not enough players');
            }
        } catch (e) {
            console.error('selection timeout:', e);
        }
    }, Math.max(5, seconds) * 1000);

    selectionTimers.set(roomId, timer);
}

async function cancelRoomAndRefund(roomId, reason = 'Game cancelled') {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const room = await client.query(
            `SELECT * FROM rooms WHERE id=$1 FOR UPDATE`,
            [roomId]
        );
        if (!room.rows.length) {
            await client.query('ROLLBACK');
            return;
        }

        const players = await client.query(
            `SELECT user_id FROM room_players WHERE room_id=$1 AND left_at IS NULL FOR UPDATE`,
            [roomId]
        );

        for (const p of players.rows) {
            await releaseStake(client, p.user_id, roomId, true);
        }

        await client.query(
            `UPDATE rooms SET status='ENDED', state='ENDED', ended_at=CURRENT_TIMESTAMP WHERE id=$1`,
            [roomId]
        );

        await client.query('COMMIT');

        stopNumberCaller(roomId);
        clearSelectionTimer(roomId);

        broadcastToRoom(roomId, 'gameEnd', {
            winners: [],
            prizePerWinner: 0,
            reason
        });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('cancelRoomAndRefund:', e);
    } finally {
        client.release();
    }
}

async function finishRoomNoWinner(roomId) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const roomResult = await client.query(
            `SELECT * FROM rooms WHERE id=$1 FOR UPDATE`,
            [roomId]
        );
        if (!roomResult.rows.length) {
            await client.query('ROLLBACK');
            return;
        }

        const room = roomResult.rows[0];
        if (room.state === 'ENDED') {
            await client.query('ROLLBACK');
            return;
        }

        const players = await client.query(
            `SELECT user_id FROM room_players WHERE room_id=$1 AND left_at IS NULL FOR UPDATE`,
            [roomId]
        );

        for (const p of players.rows) {
            await releaseStake(client, p.user_id, roomId, true);
        }

        await client.query(
            `UPDATE rooms SET status='ENDED', state='ENDED', ended_at=CURRENT_TIMESTAMP WHERE id=$1`,
            [roomId]
        );

        await client.query(
            `INSERT INTO game_history
             (room_id, game_number, stake, total_players, total_cards,
              prize_pool, called_numbers, started_at, ended_at, winning_pattern)
             VALUES ($1,$2,$3,$4,
                     (SELECT COALESCE(SUM(jsonb_array_length(cards)),0) FROM room_players WHERE room_id=$1),
                     0,$5,$6,CURRENT_TIMESTAMP,'NO_WINNER')`,
            [roomId, room.game_number, room.stake, players.rows.length, room.called_numbers]
        );

        await client.query('COMMIT');

        stopNumberCaller(roomId);
        broadcastToRoom(roomId, 'gameEnd', {
            winners: [],
            prizePerWinner: 0
        });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('finishRoomNoWinner:', e);
    } finally {
        client.release();
    }
}

async function finishRoomWithWinners(roomId, winners, calledNumbers) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const roomResult = await client.query(
            `SELECT * FROM rooms WHERE id=$1 FOR UPDATE`,
            [roomId]
        );
        if (!roomResult.rows.length) {
            await client.query('ROLLBACK');
            return;
        }

        const room = roomResult.rows[0];
        if (room.state === 'ENDED') {
            await client.query('ROLLBACK');
            return;
        }

        const unique = [];
        const seenPlayers = new Set();

        for (const w of winners) {
            if (!seenPlayers.has(String(w.playerId))) {
                seenPlayers.add(String(w.playerId));
                unique.push(w);
            }
        }

        const prizePool = Number(room.prize_pool || 0);
        const prizePerWinner = unique.length ? Math.round((prizePool / unique.length) * 100) / 100 : 0;

        for (const winner of unique) {
            const userResult = await client.query(
                `SELECT id, balance, locked_balance, first_name
                 FROM users WHERE id=$1 FOR UPDATE`,
                [winner.playerId]
            );
            if (!userResult.rows.length) continue;

            const user = userResult.rows[0];
            const before = Number(user.balance);
            const locked = Number(user.locked_balance);
            const after = before + prizePerWinner;

            await client.query(
                `UPDATE users
                 SET balance=$1,
                     locked_balance=GREATEST(0, locked_balance - $2),
                     total_wins=COALESCE(total_wins,0)+1,
                     total_winnings=COALESCE(total_winnings,0)+$3
                 WHERE id=$4`,
                [after, Math.min(locked, Number(room.stake)), prizePerWinner, winner.playerId]
            );

            await addLedger(
                client,
                winner.playerId,
                'WIN',
                prizePerWinner,
                before,
                after,
                'ROOM',
                roomId
            );

            await client.query(
                `UPDATE room_players
                 SET is_winner=TRUE, winning_amount=$1
                 WHERE room_id=$2 AND user_id=$3`,
                [prizePerWinner, roomId, winner.playerId]
            );

            await client.query(
                `INSERT INTO game_winners
                 (room_id,user_id,card_id,pattern,prize)
                 VALUES ($1,$2,$3,$4,$5)`,
                [
                    roomId,
                    winner.playerId,
                    Number(winner.cardNumber),
                    winner.patterns?.[0]?.type || 'ANY',
                    prizePerWinner
                ]
            );
        }

        const allPlayers = await client.query(
            `SELECT user_id FROM room_players WHERE room_id=$1 AND left_at IS NULL FOR UPDATE`,
            [roomId]
        );

        for (const p of allPlayers.rows) {
            await releaseStake(client, p.user_id, roomId, false);
        }

        const winner = unique[0] || null;

        await client.query(
            `UPDATE rooms
             SET status='ENDED', state='ENDED', ended_at=CURRENT_TIMESTAMP,
                 called_numbers=$2::jsonb
             WHERE id=$1`,
            [roomId, JSON.stringify(calledNumbers)]
        );

        await client.query(
            `INSERT INTO game_history
             (room_id, game_number, stake, total_players, total_cards,
              prize_pool, winner_id, winner_name, winner_card,
              winning_amount, winning_pattern, called_numbers,
              started_at, ended_at)
             SELECT $1,$2,$3,
                    COUNT(DISTINCT rp.user_id),
                    COALESCE(SUM(jsonb_array_length(rp.cards)),0),
                    $4,$5,u.first_name,$6,$7,$8,$9,r.started_at,CURRENT_TIMESTAMP
             FROM rooms r
             JOIN room_players rp ON rp.room_id=r.id
             LEFT JOIN users u ON u.id=$5
             WHERE r.id=$1
             GROUP BY u.first_name,r.started_at`,
            [
                roomId,
                room.game_number,
                room.stake,
                prizePool,
                winner?.playerId || null,
                winner?.cardNumber || null,
                prizePerWinner,
                winner?.patterns?.[0]?.type || 'ANY',
                JSON.stringify(calledNumbers)
            ]
        );

        await client.query(
            `UPDATE users
             SET total_games_played=COALESCE(total_games_played,0)+1
             WHERE id IN (SELECT user_id FROM room_players WHERE room_id=$1)`,
            [roomId]
        );

        await client.query('COMMIT');

        stopNumberCaller(roomId);

        const winningCards = await getGameCards(roomId, calledNumbers);
        const winnerPayload = unique.map(w => {
            const card = winningCards.find(c =>
                String(c.playerId) === String(w.playerId) &&
                Number(c.cardNumber) === Number(w.cardNumber)
            );
            return {
                playerId: String(w.playerId),
                playerName: card?.playerName || 'Player',
                cardNumber: Number(w.cardNumber),
                board: card?.board || [],
                marked: card?.marked || [],
                patterns: w.patterns || []
            };
        });

        broadcastToRoom(roomId, 'gameEnd', {
            winners: winnerPayload,
            prizePerWinner
        });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('finishRoomWithWinners:', e);
    } finally {
        client.release();
    }
}

// ============================================================
// REST API
// ============================================================

app.post('/api/users/register', async (req, res) => {
    try {
        const { telegramId, username, firstName, lastName, photoUrl, telegramInitData } = req.body;

        if (!telegramId || !firstName) {
            return res.status(400).json({ success: false, error: 'telegramId and firstName are required' });
        }

        const telegramCheck = verifyTelegramWebAppInitData(telegramInitData);
        const browserTesting = String(process.env.ALLOW_BROWSER_TESTING || '').toLowerCase() === 'true';
        const botTokenHeader = String(req.headers['x-bot-token'] || '');
        const configuredBotToken = String(process.env.BOT_TOKEN || '');
        const botAuthorized = Boolean(configuredBotToken && botTokenHeader && botTokenHeader === configuredBotToken);

        if (!telegramCheck.valid && !browserTesting && !botAuthorized) {
            return res.status(401).json({
                success: false,
                error: 'Telegram authentication is required',
                reason: telegramCheck.reason
            });
        }

        if (telegramCheck.valid && !botAuthorized) {
            const params = new URLSearchParams(telegramInitData);
            const tgUser = JSON.parse(params.get('user') || '{}');
            if (String(tgUser.id) !== String(telegramId)) {
                return res.status(401).json({ success: false, error: 'Telegram user mismatch' });
            }
        }

        const existing = await pool.query(
            `SELECT * FROM users WHERE telegram_id=$1`,
            [telegramId]
        );

        if (existing.rows.length) {
            await pool.query(
                `UPDATE users
                 SET username=COALESCE($2,username),
                     first_name=COALESCE($3,first_name),
                     last_name=COALESCE($4,last_name),
                     photo_url=COALESCE($5,photo_url),
                     last_login=CURRENT_TIMESTAMP
                 WHERE telegram_id=$1`,
                [telegramId, username || null, firstName || null, lastName || null, photoUrl || null]
            );

            const updated = await pool.query(`SELECT * FROM users WHERE telegram_id=$1`, [telegramId]);
            return res.json({ success: true, user: updated.rows[0], message: 'User already exists' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const userResult = await client.query(
                `INSERT INTO users
                 (telegram_id,username,first_name,last_name,photo_url,balance,last_login)
                 VALUES ($1,$2,$3,$4,$5,500,CURRENT_TIMESTAMP)
                 RETURNING *`,
                [telegramId, username || '', firstName, lastName || '', photoUrl || null]
            );

            const user = userResult.rows[0];

            await addLedger(client, user.id, 'SIGNUP_BONUS', 500, 0, 500, 'USER', user.id);

            await client.query('COMMIT');

            res.json({
                success: true,
                user,
                message: 'User registered with 500 Birr bonus!'
            });
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
            `SELECT card_number, board
             FROM bingo_cards
             WHERE is_active=TRUE
             ORDER BY card_number
             LIMIT 200`
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/rooms', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT r.id,r.stake,r.status,r.state,r.prize_pool,r.game_number,
                    COUNT(rp.id)::int AS player_count
             FROM rooms r
             LEFT JOIN room_players rp ON rp.room_id=r.id AND rp.left_at IS NULL
             WHERE r.state <> 'ENDED'
             GROUP BY r.id
             ORDER BY r.created_at DESC`
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/deposits', async (req, res) => {
    try {
        const { userId, amount, method, reference, metadata } = req.body;
        const user = await findUser(userId);
        const value = safeNumber(amount);

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (value < 50 || value > 5000) return res.status(400).json({ error: 'Deposit must be 50-5000 Birr' });

        const result = await pool.query(
            `INSERT INTO deposits(user_id,amount,method,reference,status,metadata)
             VALUES($1,$2,$3,$4,'PENDING',$5)
             RETURNING *`,
            [user.id, value, method || 'UNKNOWN', reference || null, metadata || null]
        );

        res.json({ success: true, deposit: result.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/withdrawals', async (req, res) => {
    const client = await pool.connect();

    try {
        const { userId, amount, method, destination } = req.body;
        const value = safeNumber(amount);

        if (value <= 0) return res.status(400).json({ error: 'Invalid amount' });
        if (!destination) return res.status(400).json({ error: 'Destination is required' });

        await client.query('BEGIN');

        const userResult = await client.query(
            `SELECT id,balance,locked_balance,COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`,
            [userId]
        );
        if (!userResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];
        const balance = Number(user.balance);
        const reserved = Number(user.withdrawal_reserved || 0);

        if (balance - reserved < value) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient available balance' });
        }

        const result = await client.query(
            `INSERT INTO withdrawals(user_id,amount,method,destination,status)
             VALUES($1,$2,$3,$4,'PENDING')
             RETURNING *`,
            [userId, value, method || 'UNKNOWN', destination]
        );
        await client.query(`UPDATE users SET withdrawal_reserved=COALESCE(withdrawal_reserved,0)+$1 WHERE id=$2`, [value, userId]);

        await client.query('COMMIT');
        res.json({ success: true, withdrawal: result.rows[0] });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// ============================================================
// NEW ENDPOINTS FOR TELEGRAM BOT
// ============================================================

// 1. Get user by username
app.get('/api/users/by-username/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const result = await pool.query(
            `SELECT * FROM users WHERE username ILIKE $1`,
            [username]
        );
        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 2. Transfer funds (HTTP)
app.post('/api/transfer', async (req, res) => {
    const { fromId, toId, amount } = req.body;
    const client = await pool.connect();
    try {
        const fromUser = await findUser(fromId);
        const toUser = await findUser(toId);
        if (!fromUser) throw new Error('Sender not found');
        if (!toUser) throw new Error('Recipient not found');

        await client.query('BEGIN');

        const fromBalanceResult = await client.query(
            `SELECT balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id = $1 FOR UPDATE`,
            [fromUser.id]
        );
        const fromBalance = Number(fromBalanceResult.rows[0].balance);
        const reserved = Number(fromBalanceResult.rows[0].withdrawal_reserved || 0);
        const amountNum = safeNumber(amount);
        if (amountNum <= 0) throw new Error('Invalid amount');
        if (fromBalance - reserved < amountNum) throw new Error('Insufficient balance');

        const toBalanceResult = await client.query(
            `SELECT balance FROM users WHERE id = $1 FOR UPDATE`,
            [toUser.id]
        );
        const toBalance = Number(toBalanceResult.rows[0].balance);

        await client.query(`UPDATE users SET balance = balance - $1 WHERE id = $2`, [amountNum, fromUser.id]);
        await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [amountNum, toUser.id]);

        await addLedger(client, fromUser.id, 'TRANSFER_OUT', amountNum, fromBalance, fromBalance - amountNum, 'TRANSFER', toUser.id);
        await addLedger(client, toUser.id, 'TRANSFER_IN', amountNum, toBalance, toBalance + amountNum, 'TRANSFER', fromUser.id);

        await client.query('COMMIT');
        res.json({ success: true, message: 'Transfer successful' });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(400).json({ success: false, message: e.message });
    } finally {
        client.release();
    }
});

// 3. Transaction history
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

// 4. Game history
app.get('/api/games/:userId', async (req, res) => {
    try {
        const user = await findUser(req.params.userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const roomsQuery = await pool.query(
            `SELECT DISTINCT room_id FROM room_players WHERE user_id = $1`,
            [user.id]
        );
        const roomIds = roomsQuery.rows.map(r => r.room_id);
        if (roomIds.length === 0) {
            return res.json({ success: true, games: [] });
        }
        const gamesResult = await pool.query(
            `SELECT * FROM game_history WHERE room_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 50`,
            [roomIds]
        );
        res.json({ success: true, games: gamesResult.rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 5. Deposit request (for bot)
app.post('/api/deposit/request', async (req, res) => {
    const { userId, amount, method, txnId } = req.body;
    const user = await findUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const value = safeNumber(amount);
    if (value < 50 || value > 5000) {
        return res.status(400).json({ success: false, message: 'Amount must be between 50 and 5000' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO deposits (user_id, amount, method, reference, status)
             VALUES ($1, $2, $3, $4, 'PENDING')
             RETURNING *`,
            [user.id, value, method || 'UNKNOWN', txnId || null]
        );
        res.json({ success: true, deposit: result.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 6. Withdraw request (for bot)
app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount, method, account } = req.body;
    const user = await findUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const value = safeNumber(amount);
    if (value <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const balanceResult = await pool.query(
        `SELECT balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id = $1`,
        [user.id]
    );
    const balance = Number(balanceResult.rows[0].balance);
    const reserved = Number(balanceResult.rows[0].withdrawal_reserved || 0);
    if (balance - reserved < value) {
        return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `INSERT INTO withdrawals (user_id, amount, method, destination, status)
             VALUES ($1, $2, $3, $4, 'PENDING')
             RETURNING *`,
            [user.id, value, method || 'UNKNOWN', account]
        );
        await client.query(`UPDATE users SET withdrawal_reserved = COALESCE(withdrawal_reserved,0) + $1 WHERE id = $2`, [value, user.id]);
        await client.query('COMMIT');
        res.json({ success: true, withdrawal: result.rows[0] });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ success: false, message: e.message });
    } finally {
        client.release();
    }
});

// 7. Process referral bonus
app.post('/api/referral/process', async (req, res) => {
    const { referrerId, newUserId } = req.body;
    const referrer = await findUser(referrerId);
    const newUser = await findUser(newUserId);
    if (!referrer || !newUser) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }
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
        const after = before + REFERRAL_BONUS;

        await client.query(`UPDATE users SET balance = $1 WHERE id = $2`, [after, referrer.id]);
        await addLedger(client, referrer.id, 'REFERRAL_BONUS', REFERRAL_BONUS, before, after, 'REFERRAL', newUser.id);

        await client.query(
            `INSERT INTO referrals (referrer_id, referred_id, bonus_amount, status, paid_at)
             VALUES ($1, $2, $3, 'PAID', CURRENT_TIMESTAMP)`,
            [referrer.id, newUser.id, REFERRAL_BONUS]
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

// 8. Admin action (generic deposit/withdraw via HTTP)
app.post('/api/admin/action', requireAdmin, async (req, res) => {
    const { adminId, action, playerId, amount } = req.body;
    const target = await findUser(playerId);
    if (!target) return res.status(404).json({ error: 'Player not found' });
    const value = safeNumber(amount);
    if (value <= 0) return res.status(400).json({ error: 'Invalid amount' });

    try {
        if (action === 'deposit') {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const user = await client.query(`SELECT balance FROM users WHERE id=$1 FOR UPDATE`, [target.id]);
                const before = Number(user.rows[0].balance);
                const after = before + value;
                await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [after, target.id]);
                await addLedger(client, target.id, 'ADMIN_DEPOSIT', value, before, after, 'ADMIN', req.admin.id);
                await client.query('COMMIT');
                res.json({ success: true, newBalance: after });
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            } finally {
                client.release();
            }
        } else if (action === 'withdraw') {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const user = await client.query(`SELECT balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`, [target.id]);
                const before = Number(user.rows[0].balance);
                const reserved = Number(user.rows[0].withdrawal_reserved || 0);
                if (before - reserved < value) throw new Error('Insufficient balance');
                const after = before - value;
                await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [after, target.id]);
                await addLedger(client, target.id, 'ADMIN_WITHDRAW', value, before, after, 'ADMIN', req.admin.id);
                await client.query('COMMIT');
                res.json({ success: true, newBalance: after });
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            } finally {
                client.release();
            }
        } else {
            return res.status(400).json({ error: 'Invalid action' });
        }
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// ============================================================
// ADMIN ENDPOINTS (existing)
// ============================================================

app.get('/api/admin/players', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id,telegram_id,first_name,username,balance,locked_balance,
                    total_wins,total_games_played,total_winnings,is_admin,status
             FROM users ORDER BY balance DESC`
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
              (SELECT COUNT(*) FROM users)::int AS "totalPlayers",
              (SELECT COUNT(*) FROM rooms WHERE state='PLAYING')::int AS "activeGames",
              (SELECT COUNT(*) FROM users WHERE status='ONLINE')::int AS "onlinePlayers",
              (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions
                 WHERE type='WIN' AND created_at::date=CURRENT_DATE) AS "todayPayouts",
              (SELECT COUNT(*) FROM rooms)::int AS "totalRooms"
        `);
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
    const result = await pool.query(
        `SELECT d.*,u.first_name AS "userName",u.telegram_id AS "userId"
         FROM deposits d JOIN users u ON u.id=d.user_id
         WHERE d.status='PENDING' ORDER BY d.created_at DESC`
    );
    res.json(result.rows);
});

app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
    const result = await pool.query(
        `SELECT w.*,u.first_name AS "userName",u.telegram_id AS "userId"
         FROM withdrawals w JOIN users u ON u.id=w.user_id
         WHERE w.status='PENDING' ORDER BY w.created_at DESC`
    );
    res.json(result.rows);
});

app.post('/api/admin/deposits/approve', requireAdmin, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const dep = await client.query(
            `SELECT * FROM deposits WHERE id=$1 AND status='PENDING' FOR UPDATE`,
            [req.body.depositId]
        );
        if (!dep.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Deposit not found' });
        }

        const d = dep.rows[0];
        const user = await client.query(
            `SELECT balance,COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`,
            [d.user_id]
        );
        const before = Number(user.rows[0].balance);
        const after = before + Number(d.amount);

        await client.query(
            `UPDATE users SET balance=$1 WHERE id=$2`,
            [after, d.user_id]
        );
        await addLedger(client, d.user_id, 'DEPOSIT', Number(d.amount), before, after, 'DEPOSIT', d.id);

        await client.query(
            `UPDATE deposits SET status='APPROVED',admin_id=$1,approved_at=CURRENT_TIMESTAMP WHERE id=$2`,
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

app.post('/api/admin/withdrawals/approve', requireAdmin, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const wr = await client.query(
            `SELECT * FROM withdrawals WHERE id=$1 AND status='PENDING' FOR UPDATE`,
            [req.body.withdrawalId]
        );
        if (!wr.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Withdrawal not found' });
        }

        const w = wr.rows[0];
        const user = await client.query(
            `SELECT balance,COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`,
            [w.user_id]
        );
        const before = Number(user.rows[0].balance);

        if (before < Number(w.amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        const after = before - Number(w.amount);

        await client.query(`UPDATE users SET balance=$1, withdrawal_reserved=GREATEST(0,COALESCE(withdrawal_reserved,0)-$2) WHERE id=$3`, [after, Number(w.amount), w.user_id]);
        await addLedger(client, w.user_id, 'WITHDRAWAL', Number(w.amount), before, after, 'WITHDRAWAL', w.id);

        await client.query(
            `UPDATE withdrawals
             SET status='APPROVED',admin_id=$1,approved_at=CURRENT_TIMESTAMP
             WHERE id=$2`,
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
        const wr = await client.query(`SELECT * FROM withdrawals WHERE id=$1 AND status='PENDING' FOR UPDATE`, [req.body.withdrawalId]);
        if (!wr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({error:'Withdrawal not found'}); }
        const w = wr.rows[0];
        await client.query(`UPDATE users SET withdrawal_reserved=GREATEST(0,COALESCE(withdrawal_reserved,0)-$1) WHERE id=$2`, [Number(w.amount), w.user_id]);
        await client.query(`UPDATE withdrawals SET status='REJECTED',admin_id=$1,rejected_at=CURRENT_TIMESTAMP,rejection_reason=$2 WHERE id=$3`, [req.admin.id, String(req.body.reason || 'Rejected by admin'), w.id]);
        await client.query('COMMIT');
        res.json({success:true});
    } catch(e) { await client.query('ROLLBACK').catch(()=>{}); res.status(500).json({error:e.message}); }
    finally { client.release(); }
});

app.post('/api/admin/balance/add', requireAdmin, async (req, res) => {
    const client = await pool.connect();

    try {
        const target = await findUser(req.body.userId);
        const amount = safeNumber(req.body.amount);

        if (!target) return res.status(404).json({ error: 'User not found' });
        if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

        await client.query('BEGIN');
        const u = await client.query(`SELECT balance,COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`, [target.id]);
        const before = Number(u.rows[0].balance);
        const after = before + amount;

        await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [after, target.id]);
        await addLedger(client, target.id, 'ADMIN_DEPOSIT', amount, before, after, 'ADMIN', req.admin.id);
        await client.query('COMMIT');

        res.json({ success: true, newBalance: after });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

app.post('/api/admin/balance/remove', requireAdmin, async (req, res) => {
    const client = await pool.connect();

    try {
        const target = await findUser(req.body.userId);
        const amount = safeNumber(req.body.amount);

        if (!target) return res.status(404).json({ error: 'User not found' });
        if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

        await client.query('BEGIN');
        const u = await client.query(`SELECT balance,COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`, [target.id]);
        const before = Number(u.rows[0].balance);
        const reserved = Number(u.rows[0].withdrawal_reserved || 0);

        if (before - reserved < amount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        const after = before - amount;
        await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [after, target.id]);
        await addLedger(client, target.id, 'ADMIN_WITHDRAW', amount, before, after, 'ADMIN', req.admin.id);
        await client.query('COMMIT');

        res.json({ success: true, newBalance: after });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// ============================================================
// WEBSOCKET GAME ENGINE
// ============================================================

wss.on('connection', ws => {
    send(ws, 'connected', { message: 'Connected to M-BINGO server' });

    ws.on('message', async raw => {
        try {
            const message = JSON.parse(raw.toString());
            const type = message.type;
            const data = message.data || {};

            switch (type) {
                case 'auth': {
                    const user = await findUser(data.userId);
                    if (!user) {
                        return sendError(ws, 'User authentication failed');
                    }

                    ws.userId = String(user.id);
                    clients.set(ws.userId, ws);

                    await pool.query(
                        `UPDATE users SET status='ONLINE',last_login=CURRENT_TIMESTAMP WHERE id=$1`,
                        [user.id]
                    );

                    const active = await pool.query(
                        `SELECT rp.room_id
                         FROM room_players rp JOIN rooms r ON r.id=rp.room_id
                         WHERE rp.user_id=$1 AND rp.left_at IS NULL AND r.state IN ('SELECTING','PLAYING')
                         ORDER BY rp.joined_at DESC LIMIT 1`,
                        [user.id]
                    );

                    if (active.rows.length) ws.roomId = active.rows[0].room_id;

                    const snapshot = ws.roomId ? await roomSnapshot(ws.roomId) : null;

                    send(ws, 'init', {
                        playerId: String(user.id),
                        players: snapshot ? snapshot.players : [],
                        gameState: snapshot ? {
                            status: String(snapshot.state).toLowerCase(),
                            stake: Number(snapshot.stake),
                            gameNumber: Number(snapshot.game_number),
                            calledNumbers: Array.isArray(snapshot.called_numbers) ? snapshot.called_numbers : [],
                            selectedCards: snapshot.players.flatMap(p => p.cards || []),
                            selectionTimeLeft: 0,
                            isPlaying: snapshot.state === 'PLAYING'
                        } : { status: 'waiting' }
                    });

                    if (snapshot?.state === 'PLAYING') {
                        const cards = await getGameCards(ws.roomId, snapshot.called_numbers || []);
                        send(ws, 'gameStart', {
                            roomId: ws.roomId,
                            gameNumber: snapshot.game_number,
                            stake: Number(snapshot.stake),
                            totalCards: cards.length,
                            prizePool: Number(snapshot.prize_pool),
                            cards
                        });
                    }
                    break;
                }

                case 'startSelection': {
                    const user = await findUser(data.userId || ws.userId);
                    const stake = validStake(data.stake);

                    if (!user) return sendError(ws, 'Please register/login first');
                    if (!stake) return sendError(ws, 'Invalid stake. Choose 10, 20, 30, 40, 50 or 100 Birr');

                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');

                        const room = await findOrCreateRoom(client, user.id, stake);

                        const joined = await client.query(
                            `SELECT id FROM room_players
                             WHERE room_id=$1 AND user_id=$2 AND left_at IS NULL
                             FOR UPDATE`,
                            [room.id, user.id]
                        );

                        if (!joined.rows.length) {
                            await client.query(
                                `INSERT INTO room_players(room_id,user_id,cards,is_ready)
                                 VALUES($1,$2,'[]'::jsonb,FALSE)`,
                                [room.id, user.id]
                            );
                        }

                        await client.query(
                            `UPDATE rooms SET status='SELECTING',state='SELECTING' WHERE id=$1`,
                            [room.id]
                        );

                        await client.query('COMMIT');

                        ws.userId = String(user.id);
                        ws.roomId = room.id;
                        clients.set(ws.userId, ws);

                        scheduleSelectionTimeout(room.id, Number(room.countdown_seconds || DEFAULT_SELECTION_SECONDS));
                        await broadcastRoomState(room.id);
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
                    if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 200) {
                        return sendError(ws, 'Invalid card number');
                    }

                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');

                        const roomResult = await client.query(
                            `SELECT * FROM rooms WHERE id=$1 FOR UPDATE`,
                            [ws.roomId]
                        );
                        if (!roomResult.rows.length) throw new Error('Room not found');

                        const room = roomResult.rows[0];
                        if (room.state !== 'SELECTING') throw new Error('Card selection is closed');

                        const cardResult = await client.query(
                            `SELECT card_number,board FROM bingo_cards
                             WHERE card_number=$1 AND is_active=TRUE`,
                            [cardNumber]
                        );
                        if (!cardResult.rows.length) throw new Error('Card not found');

                        const used = await client.query(
                            `SELECT user_id,cards FROM room_players
                             WHERE room_id=$1 AND left_at IS NULL
                             FOR UPDATE`,
                            [ws.roomId]
                        );

                        for (const p of used.rows) {
                            const cards = Array.isArray(p.cards) ? p.cards.map(Number) : [];
                            if (cards.includes(cardNumber)) throw new Error('This card is already selected');
                        }

                        const me = used.rows.find(p => String(p.user_id) === String(ws.userId));
                        if (!me) throw new Error('You are not in this room');

                        const myCards = Array.isArray(me.cards) ? me.cards.map(Number) : [];
                        if (myCards.length >= 5) throw new Error('Maximum 5 cards allowed');
                        if (myCards.includes(cardNumber)) throw new Error('You already selected this card');

                        myCards.push(cardNumber);

                        await client.query(
                            `UPDATE room_players SET cards=$1::jsonb WHERE room_id=$2 AND user_id=$3`,
                            [JSON.stringify(myCards), ws.roomId, ws.userId]
                        );

                        await client.query('COMMIT');

                        send(ws, 'cardSelectionResult', {
                            success: true,
                            cardNumber,
                            cards: myCards
                        });

                        await broadcastRoomState(ws.roomId);
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

                    const room = await roomSnapshot(ws.roomId);
                    if (!room) return sendError(ws, 'Room not found');

                    const readyPlayers = room.players.filter(p => Array.isArray(p.cards) && p.cards.length);
                    if (readyPlayers.length < Number(room.min_players || 2)) {
                        return sendError(ws, `Waiting for at least ${room.min_players || 2} players with cards`);
                    }

                    await startGame(ws.roomId);
                    break;
                }

                case 'getGameState': {
                    if (!ws.roomId) {
                        send(ws, 'gameStateUpdate', {
                            status: 'waiting',
                            selectedCards: [],
                            players: []
                        });
                        break;
                    }
                    await broadcastRoomState(ws.roomId);
                    break;
                }

                case 'transfer': {
                    if (!ws.userId) return sendError(ws, 'Not authenticated');

                    const recipient = await findUser(data.recipientId || data.phone);
                    const amount = safeNumber(data.amount);

                    if (!recipient) return sendError(ws, 'Recipient not found');
                    if (String(recipient.id) === String(ws.userId)) return sendError(ws, 'Cannot transfer to yourself');
                    if (amount <= 0) return sendError(ws, 'Invalid transfer amount');

                    await transferBalance(ws.userId, recipient.id, amount);
                    send(ws, 'transferResult', { success: true, amount, recipientId: String(recipient.id) });
                    break;
                }

                case 'adminLogin': {
                    const username = String(data.username || '').trim();
                    const password = String(data.password || '');
                    const expectedUsername = process.env.ADMIN_USERNAME || '';
                    const passwordHash = process.env.ADMIN_PASSWORD_HASH || '';
                    const adminTelegramId = process.env.ADMIN_TELEGRAM_ID || (process.env.ADMIN_IDS || '').split(',')[0];
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
                    if (!ws.userId || !(await isAdmin(ws.userId))) {
                        return send(ws, 'adminAuth', { success: false });
                    }
                    send(ws, 'adminData', { players: await getAdminPlayers() });
                    break;
                }

                case 'adminAction': {
                    if (!ws.userId || !(await isAdmin(ws.userId))) {
                        return sendError(ws, 'Admin authorization required');
                    }

                    const admin = await findUser(ws.userId);
                    const target = await findUser(data.playerId);
                    if (!target) return sendError(ws, 'Player not found');

                    const amount = safeNumber(data.amount);
                    if (amount <= 0) return sendError(ws, 'Invalid amount');

                    if (data.action === 'deposit') {
                        await adminAdjustBalance(admin.id, target.id, amount, 'ADMIN_DEPOSIT');
                    } else if (data.action === 'withdraw') {
                        await adminAdjustBalance(admin.id, target.id, -amount, 'ADMIN_WITHDRAW');
                    } else if (data.action === 'transfer') {
                        const recipient = await findUser(data.phone);
                        if (!recipient) return sendError(ws, 'Recipient not found. Enter recipient Telegram ID.');
                        if (String(recipient.id) === String(target.id)) return sendError(ws, 'Cannot transfer to same account.');
                        await transferBalance(target.id, recipient.id, amount);
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
                await pool.query(`UPDATE users SET status='OFFLINE' WHERE id=$1`, [ws.userId]);
            } catch (_) {}
        }
    });
});

async function getAdminPlayers() {
    const result = await pool.query(
        `SELECT id,first_name AS name,username,balance,locked_balance,
                total_wins AS wins,total_games_played AS games
         FROM users ORDER BY balance DESC LIMIT 500`
    );
    return result.rows.map(p => ({
        ...p,
        balance: Number(p.balance),
        locked_balance: Number(p.locked_balance),
        wins: Number(p.wins || 0),
        games: Number(p.games || 0)
    }));
}

async function adminAdjustBalance(adminId, targetId, amount, type) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const user = await client.query(
            `SELECT balance,COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`,
            [targetId]
        );
        if (!user.rows.length) throw new Error('Player not found');

        const before = Number(user.rows[0].balance);
        const after = before + amount;

        if (after < 0) throw new Error('Insufficient player balance');

        await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [after, targetId]);
        await addLedger(client, targetId, type, Math.abs(amount), before, after, 'ADMIN', adminId);

        await client.query(
            `INSERT INTO admin_logs(admin_id,action,target_user_id,details)
             VALUES($1,$2,$3,$4)`,
            [adminId, type, targetId, JSON.stringify({ amount: Math.abs(amount) })]
        );

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function transferBalance(fromId, toId, amount) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const users = await client.query(
            `SELECT id,balance,COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`,
            [fromId, toId]
        );
        if (users.rows.length !== 2) throw new Error('Transfer account not found');

        const from = users.rows.find(u => String(u.id) === String(fromId));
        const to = users.rows.find(u => String(u.id) === String(toId));

        const fromBefore = Number(from.balance);
        const toBefore = Number(to.balance);

        if (fromBefore - Number(from.withdrawal_reserved || 0) < amount) throw new Error('Insufficient available balance');

        const fromAfter = fromBefore - amount;
        const toAfter = toBefore + amount;

        await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [fromAfter, fromId]);
        await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [toAfter, toId]);

        await addLedger(client, fromId, 'TRANSFER_OUT', amount, fromBefore, fromAfter, 'TRANSFER', toId);
        await addLedger(client, toId, 'TRANSFER_IN', amount, toBefore, toAfter, 'TRANSFER', fromId);

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function resumeActiveGames() {
    try {
        const rooms = await pool.query(
            `SELECT id FROM rooms WHERE state='PLAYING' AND status='PLAYING'`
        );
        for (const r of rooms.rows) {
            startNumberCaller(r.id);
        }
        if (rooms.rows.length) {
            console.log(`♻️ Resumed ${rooms.rows.length} active game(s)`);
        }
    } catch (e) {
        console.error('resumeActiveGames:', e);
    }
}

// ============================================================
// 404 & ERROR MIDDLEWARE (Must be last)
// ============================================================

app.use((req,res,next)=>{ if(req.path.startsWith('/api/')) return res.status(404).json({error:'API route not found'}); next(); });

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, async () => {
    console.log('============================================================');
    console.log('🎯 M-BINGO FIXED V3 SERVER');
    console.log(`🌐 PORT: ${PORT}`);
    console.log(`⏱️ CALL INTERVAL: ${DEFAULT_CALL_INTERVAL} ms`);
    console.log('============================================================');
    await resumeActiveGames();
});

process.on('SIGTERM', async () => {
    for (const roomId of roomTimers.keys()) stopNumberCaller(roomId);
    for (const roomId of selectionTimers.keys()) clearSelectionTimer(roomId);
    server.close(async () => {
        await pool.end();
        process.exit(0);
    });
});

module.exports = { app, server, wss, pool };
