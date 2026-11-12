// ============================================================
// M-BINGO Telegram User Inviter (GramJS)
// Requires TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION.
// TELEGRAM_SESSION must belong to an authorized personal Telegram account.
// ============================================================

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = String(process.env.TELEGRAM_API_HASH || '').trim();
const SESSION = String(process.env.TELEGRAM_SESSION || '').trim();

// ============================================================
// FIX (Bug S): enforce a minimum inter-message delay and back
// off on PEER_FLOOD so the account is not banned.
// ============================================================
const MIN_SEND_DELAY_MS = Math.max(30_000, Number(process.env.INVITER_MIN_DELAY_MS || 30_000));
const PEER_FLOOD_BACKOFF_MS = 60_000;

let client = null;
let ready = false;
let lastError = 'Not initialized';

function log(...args) { console.log('[INVITER]', ...args); }
function logError(...args) { console.error('[INVITER][ERROR]', ...args); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function init() {
    if (ready && client) return true;

    if (!Number.isInteger(API_ID) || API_ID <= 0 || !API_HASH || !SESSION) {
        ready = false;
        lastError = 'Missing or invalid TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION';
        logError(lastError);
        return false;
    }

    try {
        client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
            connectionRetries: 5,
            useWSS: true,
        });

        await client.connect();

        const me = await client.getMe();
        if (!me || me.deleted) {
            throw new Error('Telegram session is not authorized. Create and set a valid user session.');
        }

        ready = true;
        lastError = '';
        log(`User client authenticated as ${me.username ? '@' + me.username : (me.firstName || 'Telegram user')}`);
        return true;
    } catch (error) {
        ready = false;
        lastError = error?.message || String(error);
        logError('Initialization/authentication failed:', lastError);
        try { if (client) await client.disconnect(); } catch (_) {}
        client = null;
        return false;
    }
}

function isReady() {
    return Boolean(ready && client);
}

function getStatus() {
    return { ready: isReady(), reason: lastError };
}

async function inviteToGroup(groupId, userId) {
    if (!isReady()) return false;
    try {
        await client.invoke(new Api.channels.InviteToChannel({
            channel: groupId,
            users: [userId],
        }));
        return true;
    } catch (error) {
        logError(`Group invite failed for ${userId}:`, error?.message || error);
        return false;
    }
}

async function sendDM(userId, message) {
    if (!isReady()) return false;
    try {
        await client.sendMessage(userId, { message });
        return true;
    } catch (error) {
        logError(`DM failed for ${userId}:`, error?.message || error);
        return false;
    }
}

// ============================================================
// FIX (Bug S): sendManyDMs now enforces a minimum 30 s gap and
// backs off 60 s on PEER_FLOOD. Safe for arbitrary batch sizes.
// ============================================================
async function sendManyDMs(ids, message, delayMs = MIN_SEND_DELAY_MS) {
    let sent = 0;
    let failed = 0;
    const gap = Math.max(MIN_SEND_DELAY_MS, delayMs);

    for (const id of ids) {
        if (!isReady()) { failed++; continue; }
        try {
            await client.sendMessage(id, { message });
            sent++;
        } catch (error) {
            failed++;
            const errText = error?.errorMessage || error?.message || '';
            if (String(errText).includes('PEER_FLOOD') || String(errText).includes('FLOOD')) {
                logError(`PEER_FLOOD on ${id}, backing off ${PEER_FLOOD_BACKOFF_MS} ms`);
                await sleep(PEER_FLOOD_BACKOFF_MS);
            } else {
                logError(`DM failed for ${id}:`, errText);
            }
        }
        await sleep(gap);
    }
    return { sent, failed };
}

async function getContacts() {
    if (!isReady()) {
        lastError = lastError || 'Telegram user client is not authenticated/online';
        logError('Cannot fetch contacts:', lastError);
        return [];
    }

    try {
        const contacts = await client.getContacts();
        const validUsers = (contacts || []).filter(user =>
            user &&
            user.className === 'User' &&
            !user.bot &&
            !user.deleted &&
            user.firstName
        );
        lastError = '';
        log(`Telegram returned ${contacts.length} contacts; ${validUsers.length} are valid human users.`);
        return validUsers;
    } catch (error) {
        lastError = error?.message || String(error);
        logError('Contact fetch failed:', lastError);
        return [];
    }
}

module.exports = {
    init,
    isReady,
    getStatus,
    inviteToGroup,
    sendDM,
    sendManyDMs,
    getContacts,
};
