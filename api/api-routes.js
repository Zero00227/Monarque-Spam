const crypto = require('crypto');

// ───────── Configuration obligatoire ─────────
// Plus de valeurs par défaut en dur : si l'une de ces variables manque,
// le serveur refuse de démarrer plutôt que d'utiliser un secret connu.
const REQUIRED_ENV = ['WORKER_SECRET', 'OWNER_CODE', 'OWNER_TOKEN_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`[api-routes] Variables d'environnement manquantes : ${missing.join(', ')}`);
    console.error('[api-routes] Définis-les avant de démarrer le serveur (ne jamais les coder en dur).');
    process.exit(1);
}

const WORKER_SECRET = process.env.WORKER_SECRET;
const OWNER_CODE = process.env.OWNER_CODE;
const OWNER_TOKEN_SECRET = process.env.OWNER_TOKEN_SECRET;
const OWNER_TOKEN_TTL_MS = 12 * 3600 * 1000;

const WORKER_SERVERS = (process.env.WORKER_SERVERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

if (WORKER_SERVERS.length === 0) {
    console.error('[api-routes] WORKER_SERVERS est vide. Définis-le en variable d\'environnement, ex:');
    console.error('  WORKER_SERVERS=http://1.2.3.4:3000,http://5.6.7.8:3000');
    process.exit(1);
}

function cleanNumber(raw) {
    return String(raw || '').replace(/[^0-9]/g, '');
}

async function findAvailableWorker() {
    const checks = WORKER_SERVERS.map((base) =>
        fetch(`${base}/api/status`, { signal: AbortSignal.timeout(4000) })
            .then((r) => r.json())
            .then((data) => (data.available ? base : null))
            .catch(() => null)
    );
    const results = await Promise.all(checks);
    const available = results.filter((base) => base !== null);
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
}

async function getAllSessions() {
    const checks = WORKER_SERVERS.map((base) =>
        fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(4000) })
            .then((r) => r.json())
            .then((sessions) => (Array.isArray(sessions) ? sessions : []))
            .catch(() => [])
    );
    const results = await Promise.all(checks);
    return results.flat();
}

// ───────── Jeton owner ─────────
function issueOwnerToken() {
    const expires = Date.now() + OWNER_TOKEN_TTL_MS;
    const sig = crypto.createHmac('sha256', OWNER_TOKEN_SECRET).update(String(expires)).digest('hex');
    return `${expires}.${sig}`;
}

function verifyOwnerToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return false;
    const [expiresStr, sig] = token.split('.');
    const expires = Number(expiresStr);
    if (!expires || expires < Date.now()) return false;
    const expectedSig = crypto.createHmac('sha256', OWNER_TOKEN_SECRET).update(expiresStr).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'));
    } catch (e) {
        return false;
    }
}

function requireOwner(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!verifyOwnerToken(token)) return res.status(401).json({ error: 'unauthorized' });
    next();
}

// ───────── Anti brute-force sur le code owner ─────────
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function checkLoginRateLimit(req, res) {
    const ip = getClientIp(req);
    const entry = loginAttempts.get(ip);
    if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
        const waitSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
        res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: waitSec });
        return false;
    }
    return true;
}

function registerLoginFailure(req) {
    const ip = getClientIp(req);
    const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
        entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
        entry.count = 0;
    }
    loginAttempts.set(ip, entry);
}

function registerLoginSuccess(req) {
    loginAttempts.delete(getClientIp(req));
}

// Purge périodique pour ne pas accumuler indéfiniment des IP en mémoire
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of loginAttempts.entries()) {
        if (!entry.lockedUntil || entry.lockedUntil < now) loginAttempts.delete(ip);
    }
}, 30 * 60 * 1000);

module.exports = function setupApiRoutes(app) {

    app.post('/api/pair', async (req, res) => {
        const number = cleanNumber(req.body.number);
        if (number.length < 7) return res.status(400).json({ error: 'invalid_number' });

        const workerBase = await findAvailableWorker();
        if (!workerBase) return res.status(503).json({ error: 'no_server_available' });

        try {
            const r = await fetch(`${workerBase}/api/generate-pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
                body: JSON.stringify({ numero: number }),
                signal: AbortSignal.timeout(20000)
            });
            const data = await r.json();
            if (!data.success) return res.status(400).json({ error: data.error || 'pairing_failed' });
            res.json({ success: true, code: data.code });
        } catch (e) {
            res.status(500).json({ error: 'pairing_failed' });
        }
    });

    app.get('/api/my-numbers', async (req, res) => {
        const raw = String(req.query.numbers || '');
        const myNumeros = raw.split(',').map(cleanNumber).filter(Boolean);
        if (myNumeros.length === 0) return res.json({ numbers: [] });

        const sessions = await getAllSessions();
        const numbers = myNumeros.map((numero) => {
            const session = sessions.find((s) => cleanNumber(s.numero) === numero);
            return session || { numero, status: 'disconnected' };
        });
        res.json({ numbers });
    });

    app.post('/api/disconnect', async (req, res) => {
        const number = cleanNumber(req.body.number);
        if (!number) return res.status(400).json({ error: 'invalid_number' });

        await Promise.allSettled(
            WORKER_SERVERS.map((base) =>
                fetch(`${base}/api/disconnect`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ numero: number }),
                    signal: AbortSignal.timeout(6000)
                }).then((r) => r.json())
            )
        );

        res.json({ success: true });
    });

    app.get('/api/stats', async (req, res) => {
        const sessions = await getAllSessions();
        const connected = sessions.filter((s) => s.status === 'connected' || s.status === 'connecting' || s.status === 'reconnecting');
        res.json({ online: connected.length, total: sessions.length });
    });

    app.get('/api/paired-list', async (req, res) => {
        const sessions = await getAllSessions();
        res.json({ numbers: sessions });
    });

    app.post('/api/owner/verify', (req, res) => {
        if (!checkLoginRateLimit(req, res)) return;

        const code = String(req.body.code || '');
        if (code !== OWNER_CODE) {
            registerLoginFailure(req);
            return res.status(401).json({ error: 'invalid_code' });
        }
        registerLoginSuccess(req);
        res.json({ token: issueOwnerToken() });
    });

    app.get('/api/owner/sessions', requireOwner, async (req, res) => {
        const sessions = await getAllSessions();
        res.json({ numbers: sessions });
    });

    app.post('/api/owner/disconnect', requireOwner, async (req, res) => {
        const number = cleanNumber(req.body.number);
        if (!number) return res.status(400).json({ error: 'invalid_number' });

        const results = await Promise.allSettled(
            WORKER_SERVERS.map((base) =>
                fetch(`${base}/api/disconnect`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ numero: number }),
                    signal: AbortSignal.timeout(6000)
                }).then((r) => r.json())
            )
        );

        const success = results.some((r) => r.status === 'fulfilled' && r.value?.success);
        if (!success) return res.status(400).json({ error: 'disconnect_failed' });
        res.json({ success: true });
    });
};
