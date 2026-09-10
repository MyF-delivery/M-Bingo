// ============================================================
// services/game.js
// Full Bingo game logic – rooms, selection, number calling,
// winners, and commission tracking (20% house cut).
// ============================================================

const { Pool } = require('pg');
const pool = require('../db'); // use the shared pool from app.js

// Timers keyed by roomId
const roomTimers = new Map();          // number-caller timers
const selectionTimers = new Map();     // selection-timeout timers

// Broadcast function (set from app.js via game.broadcastToRoom = ...)
let broadcastToRoom = () => {};

// ------------------------------------------------------------
// ROOM MANAGEMENT
// ------------------------------------------------------------

/**
 * Find an open room with the given stake or create a new one.
 * Returns the room row.
 */
async function findOrCreateRoom(client, userId, stake) {
    // Look for a room in WAITING or SELECTING state with matching stake
    const existing = await client.query(
        `SELECT * FROM rooms
         WHERE stake = $1 AND state IN ('WAITING','SELECTING')
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE`,
        [stake]
    );
    if (existing.rows.length) return existing.rows[0];

    // Otherwise create a new room
    const created = await client.query(
        `INSERT INTO rooms (stake, state, status, countdown_seconds, game_number, called_numbers, prize_pool)
         VALUES ($1, 'SELECTING', 'SELECTING', $2, 0, '[]'::jsonb, 0)
         RETURNING *`,
        [stake, Number(process.env.BINGO_SELECTION_SECONDS || 60)]
    );
    return created.rows[0];
}

// ------------------------------------------------------------
// SELECTION TIMEOUT
// ------------------------------------------------------------

function scheduleSelectionTimeout(roomId, seconds) {
    clearSelectionTimer(roomId);
    const ms = Math.max(5, Number(seconds || 60)) * 1000;
    const t = setTimeout(async () => {
        try {
            const room = await pool.query(`SELECT * FROM rooms WHERE id = $1`, [roomId]);
            if (!room.rows.length) return;
            if (room.rows[0].state !== 'SELECTING') return;

            // Count players with cards
            const players = await pool.query(
                `SELECT user_id, cards FROM room_players WHERE room_id = $1 AND left_at IS NULL`,
                [roomId]
            );
            const withCards = players.rows.filter(p => Array.isArray(p.cards) && p.cards.length > 0);

            if (withCards.length >= 2) {
                await startGame(roomId);
            } else {
                // Not enough players – reset the room to WAITING and clear cards
                await pool.query(
                    `UPDATE room_players SET cards = '[]'::jsonb WHERE room_id = $1`,
                    [roomId]
                );
                await pool.query(
                    `UPDATE rooms SET state = 'WAITING', status = 'WAITING', created_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [roomId]
                );
                broadcastToRoom(roomId, 'gameStateUpdate', {
                    status: 'waiting',
                    roomId,
                    selectedCards: [],
                    players: []
                });
            }
        } catch (e) {
            console.error('Selection timeout error:', e);
        } finally {
            selectionTimers.delete(roomId);
        }
    }, ms);
    selectionTimers.set(roomId, t);
}

function clearSelectionTimer(roomId) {
    const t = selectionTimers.get(roomId);
    if (t) { clearTimeout(t); selectionTimers.delete(roomId); }
}

// ------------------------------------------------------------
// ROOM SNAPSHOT
// ------------------------------------------------------------

async function roomSnapshot(roomId) {
    const result = await pool.query(
        `SELECT r.*,
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object(
                      'user_id', rp.user_id,
                      'cards',   rp.cards,
                      'is_ready', rp.is_ready
                    )
                  ) FILTER (WHERE rp.user_id IS NOT NULL),
                  '[]'::jsonb
                ) AS players
         FROM rooms r
         LEFT JOIN room_players rp
           ON rp.room_id = r.id AND rp.left_at IS NULL
         WHERE r.id = $1
         GROUP BY r.id`,
        [roomId]
    );
    const row = result.rows[0];
    if (!row) return null;
    // Normalise the players array to the shape the frontend expects
    row.players = (row.players || []).map(p => ({
        id: String(p.user_id),
        user_id: p.user_id,
        cards: Array.isArray(p.cards) ? p.cards.map(Number) : [],
        is_ready: p.is_ready
    }));
    return row;
}

// ------------------------------------------------------------
// GET CARDS FOR A ROOM (with marked flags)
// ------------------------------------------------------------

async function getGameCards(roomId, calledNumbers = []) {
    const snapshot = await roomSnapshot(roomId);
    if (!snapshot) return [];
    const calledSet = new Set((calledNumbers || []).map(Number));

    const result = [];
    for (const player of snapshot.players) {
        for (const cardNumber of player.cards) {
            const cardRes = await pool.query(
                `SELECT card_number, board FROM bingo_cards WHERE card_number = $1`,
                [cardNumber]
            );
            if (!cardRes.rows.length) continue;
            const board = cardRes.rows[0].board;

            // Build marked matrix
            const marked = Array(5).fill().map(() => Array(5).fill(false));
            for (let r = 0; r < 5; r++) {
                for (let c = 0; c < 5; c++) {
                    const val = board[r][c];
                    if (val === '★' || val === 0) marked[r][c] = true;
                    else if (calledSet.has(Number(val))) marked[r][c] = true;
                }
            }
            result.push({
                playerId: String(player.id),
                cardNumber,
                board,
                marked
            });
        }
    }
    return result;
}

// ------------------------------------------------------------
// START GAME – deduct stakes, commission, start number caller
// ------------------------------------------------------------

async function startGame(roomId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const roomRes = await client.query(
            `SELECT * FROM rooms WHERE id = $1 FOR UPDATE`,
            [roomId]
        );
        if (!roomRes.rows.length) throw new Error('Room not found');
        const room = roomRes.rows[0];

        const playersRes = await client.query(
            `SELECT user_id, cards FROM room_players
             WHERE room_id = $1 AND left_at IS NULL FOR UPDATE`,
            [roomId]
        );
        const players = playersRes.rows.filter(p => Array.isArray(p.cards) && p.cards.length > 0);

        if (players.length < 2) {
            await client.query('ROLLBACK');
            throw new Error('Need at least 2 players with cards');
        }

        // Deduct stake * cards from each player
        let totalPool = 0;
        for (const p of players) {
            const payAmount = Number(room.stake) * p.cards.length;
            if (payAmount <= 0) continue;

            const balRes = await client.query(
                `SELECT balance FROM users WHERE id = $1 FOR UPDATE`,
                [p.user_id]
            );
            const before = Number(balRes.rows[0].balance);
            if (before < payAmount) {
                throw new Error(`Insufficient balance for user ${p.user_id}`);
            }
            const after = before - payAmount;
            await client.query(
                `UPDATE users SET balance = $1 WHERE id = $2`,
                [after, p.user_id]
            );
            await client.query(
                `INSERT INTO wallet_transactions
                 (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
                 VALUES ($1, 'GAME_STAKE', $2, $3, $4, 'ROOM', $5)`,
                [p.user_id, payAmount, before, after, roomId]
            );
            totalPool += payAmount;
        }

        const commission = Number((totalPool * 0.2).toFixed(2));
        const winnerPool = Number((totalPool * 0.8).toFixed(2));

        // Save commission record
        await client.query(
            `INSERT INTO commissions (room_id, total_stake, commission_amount)
             VALUES ($1, $2, $3)`,
            [roomId, totalPool, commission]
        );

        // Update room
        await client.query(
            `UPDATE rooms
             SET prize_pool = $1,
                 state = 'PLAYING',
                 status = 'PLAYING',
                 game_number = COALESCE(game_number, 0) + 1,
                 called_numbers = '[]'::jsonb,
                 started_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [winnerPool, roomId]
        );

        await client.query('COMMIT');

        // Kick off the number caller (async, not awaited)
        startNumberCaller(roomId);

        return {
            success: true,
            roomId,
            stake: Number(room.stake),
            totalPool,
            commission,
            prizePool: winnerPool
        };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('startGame error:', e);
        throw e;
    } finally {
        client.release();
    }
}

// ------------------------------------------------------------
// END GAME – pay winners, mark room ENDED
// ------------------------------------------------------------

async function endGame(roomId, winners) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const roomRes = await client.query(
            `SELECT prize_pool FROM rooms WHERE id = $1 FOR UPDATE`,
            [roomId]
        );
        if (!roomRes.rows.length) throw new Error('Room not found');
        const prizePool = Number(roomRes.rows[0].prize_pool);

        const prizePerWinner = winners.length
            ? Number((prizePool / winners.length).toFixed(2))
            : 0;

        for (const w of winners) {
            const balRes = await client.query(
                `SELECT balance FROM users WHERE id = $1 FOR UPDATE`,
                [w.user_id]
            );
            const before = Number(balRes.rows[0].balance);
            const after = before + prizePerWinner;
            await client.query(
                `UPDATE users SET balance = $1 WHERE id = $2`,
                [after, w.user_id]
            );
            await client.query(
                `INSERT INTO wallet_transactions
                 (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
                 VALUES ($1, 'GAME_WIN', $2, $3, $4, 'ROOM', $5)`,
                [w.user_id, prizePerWinner, before, after, roomId]
            );
        }

        await client.query(
            `UPDATE rooms
             SET state = 'ENDED',
                 status = 'ENDED',
                 ended_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [roomId]
        );

        await client.query('COMMIT');

        stopNumberCaller(roomId);
        return { success: true, prizePerWinner };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('endGame error:', e);
        throw e;
    } finally {
        client.release();
    }
}

// ------------------------------------------------------------
// NUMBER CALLER + BINGO DETECTION
// ------------------------------------------------------------

function startNumberCaller(roomId) {
    stopNumberCaller(roomId);
    const intervalMs = Number(process.env.BINGO_CALL_INTERVAL_MS || 10000);
    const calledNumbers = [];

    const tick = async () => {
        try {
            const roomRes = await pool.query(
                `SELECT * FROM rooms WHERE id = $1`,
                [roomId]
            );
            if (!roomRes.rows.length) return stopNumberCaller(roomId);
            const room = roomRes.rows[0];
            if (room.state !== 'PLAYING') return stopNumberCaller(roomId);

            // Generate a new unique number 1-75
            let num;
            do {
                num = Math.floor(Math.random() * 75) + 1;
            } while (calledNumbers.includes(num) && calledNumbers.length < 75);

            if (calledNumbers.length >= 75) {
                // All numbers called – end with no winner
                stopNumberCaller(roomId);
                broadcastToRoom(roomId, 'gameEnd', {
                    winners: [],
                    prizePerWinner: 0,
                    calledNumbers
                });
                await endGame(roomId, []);
                return;
            }

            calledNumbers.push(num);

            await pool.query(
                `UPDATE rooms SET called_numbers = $1::jsonb WHERE id = $2`,
                [JSON.stringify(calledNumbers), roomId]
            );

            const cards = await getGameCards(roomId, calledNumbers);
            broadcastToRoom(roomId, 'numberCalled', {
                number: num,
                calledNumbers,
                calledCount: calledNumbers.length,
                cards
            });

            // Check for winners
            const winners = detectWinners(cards);
            if (winners.length > 0) {
                stopNumberCaller(roomId);

                // Augment with playerId & names
                const enriched = [];
                for (const w of winners) {
                    const u = await pool.query(
                        `SELECT id, first_name FROM users WHERE id = $1`,
                        [w.playerId]
                    );
                    enriched.push({
                        ...w,
                        user_id: w.playerId,
                        playerName: u.rows[0]?.first_name || 'Player'
                    });
                }

                const roomInfo = await pool.query(
                    `SELECT prize_pool FROM rooms WHERE id = $1`,
                    [roomId]
                );
                const prizePool = Number(roomInfo.rows[0]?.prize_pool || 0);
                const prizePerWinner = enriched.length
                    ? Number((prizePool / enriched.length).toFixed(2))
                    : 0;

                await endGame(roomId, enriched.map(w => ({ user_id: w.playerId })));

                broadcastToRoom(roomId, 'gameEnd', {
                    winners: enriched,
                    prizePerWinner,
                    calledNumbers
                });

                // Reset room after 10 seconds for next round
                setTimeout(async () => {
                    try {
                        await pool.query(
                            `UPDATE room_players SET cards = '[]'::jsonb WHERE room_id = $1`,
                            [roomId]
                        );
                        await pool.query(
                            `UPDATE rooms
                             SET state = 'SELECTING',
                                 status = 'SELECTING',
                                 called_numbers = '[]'::jsonb,
                                 prize_pool = 0,
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
                                players: snap.players
                            });
                            scheduleSelectionTimeout(roomId, Number(snap.countdown_seconds || 60));
                        }
                    } catch (e) {
                        console.error('Room reset error:', e);
                    }
                }, 10000);
                return;
            }

            // Schedule the next tick
            const t = setTimeout(tick, intervalMs);
            roomTimers.set(roomId, t);
        } catch (e) {
            console.error('numberCaller error:', e);
            stopNumberCaller(roomId);
        }
    };

    // First call after intervalMs
    const t = setTimeout(tick, intervalMs);
    roomTimers.set(roomId, t);
}

function stopNumberCaller(roomId) {
    const t = roomTimers.get(roomId);
    if (t) { clearTimeout(t); roomTimers.delete(roomId); }
}

// ------------------------------------------------------------
// WINNER DETECTION
// ------------------------------------------------------------

function detectWinners(cards) {
    const winners = [];
    for (const card of cards) {
        const patterns = [];
        const m = card.marked;
        const b = card.board;

        // Rows
        for (let r = 0; r < 5; r++) {
            if (m[r].every(Boolean)) patterns.push({ type: 'row', index: r, label: `Row ${r + 1}` });
        }
        // Columns
        for (let c = 0; c < 5; c++) {
            let full = true;
            for (let r = 0; r < 5; r++) if (!m[r][c]) { full = false; break; }
            if (full) patterns.push({ type: 'column', index: c, label: `Column ${c + 1}` });
        }
        // Diagonals
        let diag1 = true, diag2 = true;
        for (let i = 0; i < 5; i++) {
            if (!m[i][i]) diag1 = false;
            if (!m[i][4 - i]) diag2 = false;
        }
        if (diag1) patterns.push({ type: 'diagonal', index: 0, label: 'Diagonal ↘' });
        if (diag2) patterns.push({ type: 'diagonal', index: 1, label: 'Diagonal ↙' });
        // Corners
        if (m[0][0] && m[0][4] && m[4][0] && m[4][4]) {
            patterns.push({ type: 'corner', index: 0, label: 'Corners' });
        }
        // Full house
        let fullHouse = true;
        for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (!m[r][c]) fullHouse = false;
        if (fullHouse) patterns.push({ type: 'full', index: 0, label: 'Full House' });

        if (patterns.length) {
            winners.push({
                playerId: card.playerId,
                cardNumber: card.cardNumber,
                board: b,
                marked: m,
                patterns,
                bingo: true
            });
        }
    }
    return winners;
}

// ------------------------------------------------------------
// EXPORTS
// ------------------------------------------------------------

module.exports = {
    // room management
    findOrCreateRoom,
    roomSnapshot,
    getGameCards,
    // selection
    scheduleSelectionTimeout,
    clearSelectionTimer,
    // game lifecycle
    startGame,
    endGame,
    // number caller
    startNumberCaller,
    stopNumberCaller,
    // timers (exposed so app.js can clean up on SIGTERM)
    roomTimers,
    selectionTimers,
    // helper to set the broadcast function from app.js
    set broadcastToRoom(fn) { broadcastToRoom = fn; },
    get broadcastToRoom() { return broadcastToRoom; }
};
