// services/game.js
const pool = require('../db');
const config = require('../config/env');
const wallet = require('./wallet');

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

  for (let r = 0; r < 5; r++) { if (marked[r].every(Boolean)) patterns.push({ type: 'row', index: r, label: `Row ${r + 1}` }); }
  for (let c = 0; c < 5; c++) { let ok = true; for (let r = 0; r < 5; r++) if (!marked[r][c]) ok = false; if (ok) patterns.push({ type: 'column', index: c, label: `Column ${c + 1}` }); }
  if ([0,1,2,3,4].every(i => marked[i][i])) patterns.push({ type: 'diagonal', index: 0, label: 'Diagonal ↘' });
  if ([0,1,2,3,4].every(i => marked[i][4-i])) patterns.push({ type: 'diagonal', index: 1, label: 'Diagonal ↙' });
  if (marked[0][0] && marked[0][4] && marked[4][0] && marked[4][4]) patterns.push({ type: 'corner', index: 0, label: 'Corners' });
  return patterns;
}

function markedBoard(board, calledSet) {
  return normalizeBoard(board).map(row => row.map(v => v === 0 || calledSet.has(Number(v))));
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
    `SELECT rp.user_id AS id, u.first_name AS name, u.username, u.balance,
            rp.cards, rp.is_ready, rp.is_winner, rp.winning_amount
     FROM room_players rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id = $1 AND rp.left_at IS NULL
     ORDER BY rp.joined_at`,
    [roomId]
  );
  return { ...room, players: playersResult.rows.map(p => ({ ...p, cards: Array.isArray(p.cards) ? p.cards : [] })) };
}

async function getGameCards(roomId, calledNumbers) {
  const calledSet = new Set(calledNumbers.map(Number));
  const result = await pool.query(
    `SELECT rp.user_id, rp.cards, u.first_name AS player_name
     FROM room_players rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id = $1 AND rp.left_at IS NULL`,
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
    `SELECT card_number, board FROM bingo_cards WHERE card_number = ANY($1::int[]) ORDER BY card_number`,
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

async function findOrCreateRoom(client, userId, stake) {
  const existing = await client.query(
    `SELECT r.* FROM rooms r
     WHERE r.stake = $1 AND r.state IN ('WAITING','SELECTING') AND r.status IN ('WAITING','SELECTING')
       AND (SELECT COUNT(*) FROM room_players rp WHERE rp.room_id = r.id AND rp.left_at IS NULL) < r.max_players
       AND NOT EXISTS (SELECT 1 FROM room_players mine WHERE mine.room_id = r.id AND mine.user_id = $2 AND mine.left_at IS NULL)
     ORDER BY r.created_at ASC LIMIT 1 FOR UPDATE`,
    [stake, userId]
  );
  if (existing.rows.length) return existing.rows[0];
  const created = await client.query(
    `INSERT INTO rooms
     (stake, max_players, min_players, status, state, countdown_seconds, calling_interval_ms, winning_pattern, prize_pool, game_number, number_sequence, called_numbers, current_call_index)
     VALUES ($1,100,$2,'WAITING','SELECTING',$3,$4,'ANY',0,0,'[]'::jsonb,'[]'::jsonb,0)
     RETURNING *`,
    [stake, config.BINGO_MIN_PLAYERS, config.BINGO_SELECTION_SECONDS, config.BINGO_CALL_INTERVAL_MS]
  );
  return created.rows[0];
}

// ** START GAME **
async function startGame(roomId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roomResult = await client.query(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [roomId]);
    if (!roomResult.rows.length) throw new Error('Room not found');
    const room = roomResult.rows[0];
    if (room.state === 'PLAYING') { await client.query('COMMIT'); return false; }

    const rpResult = await client.query(
      `SELECT rp.user_id, rp.cards FROM room_players rp WHERE rp.room_id = $1 AND rp.left_at IS NULL FOR UPDATE`,
      [roomId]
    );
    if (rpResult.rows.length < Number(room.min_players || 2)) { await client.query('ROLLBACK'); return false; }
    const activePlayers = rpResult.rows.filter(p => Array.isArray(p.cards) && p.cards.length > 0);
    if (activePlayers.length < Number(room.min_players || 2)) { await client.query('ROLLBACK'); return false; }

    let totalStake = 0;
    for (const p of activePlayers) {
      const cardCount = p.cards.length;
      const totalCost = Number(room.stake) * cardCount;
      totalStake += totalCost;
      await wallet.chargeStake(client, p.user_id, roomId, Number(room.stake), cardCount);
    }

    const sequence = shuffled75();
    const gameNumber = Number(room.game_number || 0) + 1;
    const prizePool = Math.round(totalStake * 0.70 * 100) / 100;

    await client.query(
      `UPDATE rooms SET status='PLAYING', state='PLAYING', game_number=$2, number_sequence=$3::jsonb,
           current_call_index=0, called_numbers='[]'::jsonb, prize_pool=$4, started_at=CURRENT_TIMESTAMP, ended_at=NULL
       WHERE id=$1`,
      [roomId, gameNumber, JSON.stringify(sequence), prizePool]
    );
    await client.query(`UPDATE room_players SET is_ready=TRUE WHERE room_id=$1 AND left_at IS NULL`, [roomId]);
    await client.query('COMMIT');

    clearSelectionTimer(roomId);
    
    // ** THE FIX: Immediately start calling numbers **
    startNumberCaller(roomId);

    const full = await roomSnapshot(roomId);
    const cards = await getGameCards(roomId, []);
    return { roomId, gameNumber, stake: Number(full.stake), totalCards: cards.length, totalPlayers: activePlayers.length, prizePool, cards };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// ** THE MISSING NUMBER CALLER **
async function startNumberCaller(roomId) {
  stopNumberCaller(roomId);
  const snapshot = await roomSnapshot(roomId);
  if (!snapshot || snapshot.state !== 'PLAYING') return;

  const intervalMs = Number(snapshot.calling_interval_ms || config.BINGO_CALL_INTERVAL_MS);
  const sequence = Array.isArray(snapshot.number_sequence) ? snapshot.number_sequence : [];

  const timer = setInterval(async () => {
    try {
      const currentRoom = await roomSnapshot(roomId);
      if (!currentRoom || currentRoom.state !== 'PLAYING') { stopNumberCaller(roomId); return; }

      let index = Number(currentRoom.current_call_index || 0);
      if (index >= sequence.length) {
        stopNumberCaller(roomId);
        await finishRoomNoWinner(roomId);
        if (game.broadcastToRoom) game.broadcastToRoom(roomId, 'gameEnd', { winners: [], prizePerWinner: 0 });
        return;
      }

      const number = sequence[index];
      const calledNumbers = Array.isArray(currentRoom.called_numbers) ? currentRoom.called_numbers : [];
      calledNumbers.push(number);
      index++;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE rooms SET called_numbers=$2::jsonb, current_call_index=$3 WHERE id=$1`, [roomId, JSON.stringify(calledNumbers), index]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }

      const calledSet = new Set(calledNumbers.map(Number));
      const activePlayers = currentRoom.players;
      let winners = [];
      
      for (const p of activePlayers) {
        for (const cardNum of (p.cards || [])) {
          const boardRes = await pool.query(`SELECT board FROM bingo_cards WHERE card_number = $1`, [cardNum]);
          if (!boardRes.rows.length) continue;
          const patterns = checkPatterns(boardRes.rows[0].board, calledSet);
          if (patterns.length > 0) winners.push({ playerId: p.id, cardNumber: cardNum, patterns });
        }
      }

      const updatedCards = await getGameCards(roomId, calledNumbers);

      if (winners.length > 0) {
        stopNumberCaller(roomId);
        const result = await finishRoomWithWinners(roomId, winners, calledNumbers);
        if (game.broadcastToRoom) game.broadcastToRoom(roomId, 'gameEnd', result);
      } else {
        // ** Send the numbers, letters, and updated cards to the frontend **
        if (game.broadcastToRoom) {
          game.broadcastToRoom(roomId, 'numberCalled', {
            number: number,
            calledNumbers: calledNumbers,
            calledCount: calledNumbers.length,
            cards: updatedCards
          });
        }
      }
    } catch (e) {
      console.error('Number caller error:', e);
      stopNumberCaller(roomId);
    }
  }, intervalMs);

  roomTimers.set(roomId, timer);
}

// (FinishNoWinner, FinishWithWinners, Timers, CancelRoom, etc. remain the same)
async function finishRoomNoWinner(roomId) { /* ... */ }
async function finishRoomWithWinners(roomId, winners, calledNumbers) { /* ... */ }

const roomTimers = new Map();
const selectionTimers = new Map();

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

function scheduleSelectionTimeout(roomId, seconds, onTimeout) {
  clearSelectionTimer(roomId);
  const timer = setTimeout(async () => {
    try {
      const snapshot = await roomSnapshot(roomId);
      if (!snapshot || snapshot.state !== 'SELECTING') return;
      const playersWithCards = snapshot.players.filter(p => Array.isArray(p.cards) && p.cards.length);
      if (playersWithCards.length >= Number(snapshot.min_players || 2)) await startGame(roomId);
      else await cancelRoomAndRefund(roomId, 'Not enough players');
      if (onTimeout) onTimeout(roomId);
    } catch (e) { console.error('selection timeout:', e); }
  }, Math.max(5, seconds) * 1000);
  selectionTimers.set(roomId, timer);
}

async function cancelRoomAndRefund(roomId, reason = 'Game cancelled') { /* ... */ }

module.exports = {
  shuffled75, normalizeBoard, checkPatterns, markedBoard, roomSnapshot, getGameCards,
  findOrCreateRoom, startGame, startNumberCaller, finishRoomNoWinner, finishRoomWithWinners,
  stopNumberCaller, clearSelectionTimer, scheduleSelectionTimeout, cancelRoomAndRefund,
  roomTimers, selectionTimers,
};