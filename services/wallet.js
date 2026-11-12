// services/wallet.js
const pool = require('../db'); // <-- changed
const config = require('../config/env');

// ============================================================
// FIX (Bug C): resolve any idOrTelegram to a real users.id UUID.
// Called from every public method below so a Telegram ID coming
// from the bot (e.g. when ADMIN_DB_ID is null on cold start) or
// a stale AI UUID never reaches an INSERT/UPDATE with the wrong
// type. Prevents "invalid input syntax for type uuid" failures
// that surfaced as "No AI agent found" on the first click.
// ============================================================
async function resolveUserId(idOrTelegram, client = pool) {
  if (!idOrTelegram) throw new Error('User ID required');
  const r = await client.query(
    `SELECT id FROM users WHERE id::text = $1 OR telegram_id::text = $1 LIMIT 1`,
    [String(idOrTelegram)]
  );
  if (!r.rows.length) throw new Error('User not found');
  return r.rows[0].id;
}

async function addLedger(client, userId, type, amount, before, after, referenceType = null, referenceId = null) {
  const userUuid = await resolveUserId(userId, client);
  await client.query(
    `INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userUuid, type, amount, before, after, referenceType, referenceId]
  );
}

async function getUserBalance(userId) {
  const userUuid = await resolveUserId(userId);
  const result = await pool.query(`SELECT balance FROM users WHERE id=$1`, [userUuid]);
  return result.rows[0]?.balance || 0;
}

async function chargeStake(client, userId, roomId, stake, cardCount) {
  const userUuid = await resolveUserId(userId, client);
  const userResult = await client.query(
    `SELECT id, balance, locked_balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved
     FROM users WHERE id = $1 FOR UPDATE`,
    [userUuid]
  );
  if (!userResult.rows.length) throw new Error('User not found');
  const user = userResult.rows[0];
  const balance = Number(user.balance);
  const reserved = Number(user.withdrawal_reserved || 0);
  const totalCost = stake * cardCount;
  if (balance - reserved < totalCost) {
    throw new Error(`Insufficient available balance. You need ${totalCost} Birr for ${cardCount} cards.`);
  }
  const newBalance = balance - totalCost;
  const newLocked = Number(user.locked_balance || 0) + totalCost;
  await client.query(
    `UPDATE users SET balance = $1, locked_balance = $2, last_login = CURRENT_TIMESTAMP WHERE id = $3`,
    [newBalance, newLocked, userUuid]
  );
  await addLedger(client, userUuid, 'STAKE_LOCK', totalCost, balance, newBalance, 'ROOM', roomId);
}

async function releaseStake(client, userId, roomId, refund = false, amount = null) {
  const userUuid = await resolveUserId(userId, client);
  const result = await client.query(
    `SELECT balance, locked_balance FROM users WHERE id = $1 FOR UPDATE`,
    [userUuid]
  );
  if (!result.rows.length) return;
  const u = result.rows[0];
  const locked = Number(u.locked_balance);
  const releaseAmount = Math.max(0, Math.min(locked, Number(amount ?? 0)));
  if (releaseAmount <= 0) return;
  const before = Number(u.balance);
  if (refund) {
    const after = before + releaseAmount;
    await client.query(
      `UPDATE users SET balance=$1, locked_balance=GREATEST(0,locked_balance-$2) WHERE id=$3`,
      [after, releaseAmount, userUuid]
    );
    await addLedger(client, userUuid, 'STAKE_REFUND', releaseAmount, before, after, 'ROOM', roomId);
  } else {
    await client.query(
      `UPDATE users SET locked_balance=GREATEST(0,locked_balance-$1) WHERE id=$2`,
      [releaseAmount, userUuid]
    );
  }
}

async function transferBalance(fromId, toId, amount) {
  // Resolve BOTH ids before opening the transaction
  const fromUuid = await resolveUserId(fromId);
  const toUuid   = await resolveUserId(toId);
  if (String(fromUuid) === String(toUuid)) throw new Error('Cannot transfer to yourself');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const users = await client.query(
      `SELECT id, balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved
       FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`,
      [fromUuid, toUuid]
    );
    if (users.rows.length !== 2) throw new Error('Transfer account not found');
    const from = users.rows.find(u => String(u.id) === String(fromUuid));
    const to   = users.rows.find(u => String(u.id) === String(toUuid));
    const fromBefore = Number(from.balance);
    const toBefore = Number(to.balance);
    if (fromBefore - Number(from.withdrawal_reserved || 0) < amount) throw new Error('Insufficient available balance');
    const fromAfter = fromBefore - amount;
    const toAfter = toBefore + amount;
    await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [fromAfter, fromUuid]);
    await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [toAfter, toUuid]);
    await addLedger(client, fromUuid, 'TRANSFER_OUT', amount, fromBefore, fromAfter, 'TRANSFER', toUuid);
    await addLedger(client, toUuid, 'TRANSFER_IN', amount, toBefore, toAfter, 'TRANSFER', fromUuid);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function adminAdjustBalance(adminId, targetId, amount, type) {
  // Resolve both sides up front (admin + target)
  const adminUuid = await resolveUserId(adminId);
  const targetUuid = await resolveUserId(targetId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(
      `SELECT balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`,
      [targetUuid]
    );
    if (!user.rows.length) throw new Error('Player not found');
    const before = Number(user.rows[0].balance);
    const after = before + amount;
    if (after < 0) throw new Error('Insufficient player balance');
    await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [after, targetUuid]);
    await addLedger(client, targetUuid, type, Math.abs(amount), before, after, 'ADMIN', adminUuid);
    await client.query(
      `INSERT INTO admin_logs(admin_id, action, target_user_id, details)
       VALUES($1,$2,$3,$4)`,
      [adminUuid, type, targetUuid, JSON.stringify({ amount: Math.abs(amount) })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  resolveUserId,
  addLedger,
  getUserBalance,
  chargeStake,
  releaseStake,
  transferBalance,
  adminAdjustBalance,
};
