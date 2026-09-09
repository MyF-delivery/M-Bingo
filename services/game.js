// game.js
// Complete game logic for Bingo multiplayer – includes stake deduction, prize distribution, and commission tracking.

const { Pool } = require('pg');

// PostgreSQL connection pool (adjust credentials as needed)
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'bingo',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// ----------------------------------------------------------------------
// 1. START GAME – deduct stakes, compute commission, set prize pool
// ----------------------------------------------------------------------
async function startGame(roomId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get room and players with their card selections
    const roomResult = await client.query(
      `SELECT * FROM rooms WHERE id = $1 FOR UPDATE`,
      [roomId]
    );
    if (!roomResult.rows.length) throw new Error('Room not found');
    const room = roomResult.rows[0];

    const playersResult = await client.query(
      `SELECT user_id, cards FROM room_players WHERE room_id = $1 AND left_at IS NULL`,
      [roomId]
    );
    const players = playersResult.rows;

    // 2. Deduct stake * number_of_cards from each player
    let totalPool = 0;
    const playerPayments = [];
    for (const p of players) {
      const cards = Array.isArray(p.cards) ? p.cards : [];
      const payAmount = Number(room.stake) * cards.length;
      if (payAmount > 0) {
        // Check balance with row lock
        const balanceCheck = await client.query(
          `SELECT balance FROM users WHERE id = $1 AND balance >= $2 FOR UPDATE`,
          [p.user_id, payAmount]
        );
        if (!balanceCheck.rows.length) {
          throw new Error(`User ${p.user_id} has insufficient balance`);
        }
        const before = Number(balanceCheck.rows[0].balance);
        const after = before - payAmount;
        await client.query(
          `UPDATE users SET balance = $1 WHERE id = $2`,
          [after, p.user_id]
        );
        await client.query(
          `INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
           VALUES ($1, 'GAME_STAKE', $2, $3, $4, 'ROOM', $5)`,
          [p.user_id, payAmount, before, after, roomId]
        );
        totalPool += payAmount;
        playerPayments.push({ userId: p.user_id, payAmount, cards: cards.length });
      }
    }

    // 3. Calculate commission (20%) and winner pool (80%)
    const commission = totalPool * 0.2;
    const winnerPool = totalPool * 0.8;

    // 4. Save commission record
    await client.query(
      `INSERT INTO commissions (room_id, total_stake, commission_amount)
       VALUES ($1, $2, $3)`,
      [roomId, totalPool, commission]
    );

    // 5. Update room with prize pool and mark as PLAYING
    await client.query(
      `UPDATE rooms SET prize_pool = $1, state = 'PLAYING', status = 'PLAYING', started_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [winnerPool, roomId]
    );

    // 6. Start the number caller (asynchronous, non-blocking)
    //    This function will emit numbers via WebSocket and detect winners.
    startCallingNumbers(roomId, winnerPool);

    await client.query('COMMIT');
    return { success: true, prizePool: winnerPool, totalPool, commission };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error starting game:', e);
    throw e;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------
// 2. END GAME – distribute prizes, update room state
// ----------------------------------------------------------------------
async function endGame(roomId, winners) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get the prize pool from the room
    const roomResult = await client.query(
      `SELECT prize_pool FROM rooms WHERE id = $1 FOR UPDATE`,
      [roomId]
    );
    if (!roomResult.rows.length) throw new Error('Room not found');
    const prizePool = Number(roomResult.rows[0].prize_pool);

    // 2. Split prize among winners
    const prizePerWinner = prizePool / winners.length;

    for (const w of winners) {
      // Add prize to winner's balance
      const userBefore = await client.query(
        `SELECT balance FROM users WHERE id = $1 FOR UPDATE`,
        [w.user_id]
      );
      const before = Number(userBefore.rows[0].balance);
      const after = before + prizePerWinner;
      await client.query(
        `UPDATE users SET balance = $1 WHERE id = $2`,
        [after, w.user_id]
      );
      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
         VALUES ($1, 'GAME_WIN', $2, $3, $4, 'ROOM', $5)`,
        [w.user_id, prizePerWinner, before, after, roomId]
      );
    }

    // 3. Update room state to ENDED
    await client.query(
      `UPDATE rooms SET state = 'ENDED', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [roomId]
    );

    // 4. Insert game history (optional: include commission)
    //    This assumes a 'game_history' table with room_id, prize_pool, commission, etc.
    await client.query(
      `INSERT INTO game_history (room_id, prize_pool, commission, ended_at)
       SELECT id, prize_pool, 
         (SELECT commission_amount FROM commissions WHERE room_id = rooms.id),
         CURRENT_TIMESTAMP
       FROM rooms WHERE id = $1`,
      [roomId]
    );

    await client.query('COMMIT');
    return { success: true, prizePerWinner };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error ending game:', e);
    throw e;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------
// 3. NUMBER CALLER (placeholder – implement with your own logic)
// ----------------------------------------------------------------------
async function startCallingNumbers(roomId, prizePool) {
  // This function should:
  // - Generate random numbers (1-75) in a loop
  // - Emit each number via WebSocket to the room
  // - After each call, check if any player has a BINGO
  // - When a winner is found, call endGame(roomId, winners)
  // - Stop when all numbers are called or game is manually stopped

  console.log(`Starting number caller for room ${roomId} with prize ${prizePool}`);

  // Example stub: generate numbers, but you would implement full logic here.
  // For production, you'd use setInterval or a state machine.

  // Placeholder: wait 5 seconds and end with a dummy winner for demonstration.
  // In reality, you would call endGame with actual winners.
  /*
  setTimeout(async () => {
    // Simulate a winner
    const dummyWinners = [
      { user_id: 1, card_number: 5, patterns: ['ROW', 'COLUMN'] }
    ];
    try {
      await endGame(roomId, dummyWinners);
    } catch (err) {
      console.error('Error ending game:', err);
    }
  }, 5000);
  */
}

// ----------------------------------------------------------------------
// 4. EXPORTS
// ----------------------------------------------------------------------
module.exports = {
  startGame,
  endGame,
  // You may export other functions as well
};
