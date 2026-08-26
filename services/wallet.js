// services/wallet.js
const pool = require('../db'); // <-- changed
const config = require('../config/env');

async function addLedger(client, userId, type, amount, before, after, referenceType = null, referenceId = null) {
  await client.query(
    `INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, type, amount, before, after, referenceType, referenceId]
  );
}

async function getUserBalance(userId) {
  const result = await pool.query(`SELECT balance FROM users WHERE id=$1`, [userId]);
  return result.rows[0]?.balance || 0;
}

async function chargeStake(client, userId, roomId, stake, cardCount) {
  const userResult = await client.query(
    `SELECT id, balance, locked_balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved
     FROM users WHERE id = $1 FOR UPDATE`,
    [userId]
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
    await client.query(
      `UPDATE users SET balance=$1, locked_balance=GREATEST(0,locked_balance-$2) WHERE id=$3`,
      [after, releaseAmount, userId]
    );
    await addLedger(client, userId, 'STAKE_REFUND', releaseAmount, before, after, 'ROOM', roomId);
  } else {
    await client.query(
      `UPDATE users SET locked_balance=GREATEST(0,locked_balance-$1) WHERE id=$2`,
      [releaseAmount, userId]
    );
  }
}

async function transferBalance(fromId, toId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const users = await client.query(
      `SELECT id, balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved
       FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`,
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

async function adminAdjustBalance(adminId, targetId, amount, type) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(
      `SELECT balance, COALESCE(withdrawal_reserved,0) AS withdrawal_reserved FROM users WHERE id=$1 FOR UPDATE`,
      [targetId]
    );
    if (!user.rows.length) throw new Error('Player not found');
    const before = Number(user.rows[0].balance);
    const after = before + amount;
    if (after < 0) throw new Error('Insufficient player balance');
    await client.query(`UPDATE users SET balance=$1 WHERE id=$2`, [after, targetId]);
    await addLedger(client, targetId, type, Math.abs(amount), before, after, 'ADMIN', adminId);
    await client.query(
      `INSERT INTO admin_logs(admin_id, action, target_user_id, details)
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

module.exports = {
  addLedger,
  getUserBalance,
  chargeStake,
  releaseStake,
  transferBalance,
  adminAdjustBalance,
};
