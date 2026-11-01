import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const env = process.env;
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CLIENT_ORIGIN', 'PUBLIC_URL', 'ENT_SECRET']) {
  if (!env[k]) { console.error(`Missing environment variable ${k}`); process.exit(1); }
}
const CURRENCY = env.CURRENCY || 'usd';
const stripe = new Stripe(env.STRIPE_SECRET_KEY);

// The server is the only authority on prices, gem amounts and perk limits.
const PACKS = [
  { gems: 100, cents: 99, name: '100 Dragon Gems' },
  { gems: 550, cents: 499, name: '550 Dragon Gems' },
  { gems: 1200, cents: 999, name: '1200 Dragon Gems' },
];
const PERK_COST = { aura: 300, plate: 200, feather: 150, boots: 120, coin: 250 };
const PERK_MAX = { aura: 3, plate: 5, feather: 5, boots: 3, coin: 3 };

const db = new Database(env.DB_PATH || './dragonwall.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
  gems INTEGER NOT NULL DEFAULT 0, perks TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments(
  session_id TEXT PRIMARY KEY, account TEXT NOT NULL, gems INTEGER NOT NULL,
  payment_intent TEXT, refunded INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pay_pi ON payments(payment_intent);`);

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const sign = (s) => crypto.createHmac('sha256', env.ENT_SECRET).update(s).digest('base64url');

// Signed, short-lived proof of which perks an account owns. Game hosts check it via /api/verify.
function mkEnt(id, perks) {
  const body = Buffer.from(JSON.stringify({ a: id, p: perks, x: Date.now() + 15 * 60e3 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readEnt(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const d = JSON.parse(Buffer.from(body, 'base64url').toString()); return d.x > Date.now() ? d : null; }
  catch { return null; }
}
const view = (a) => { const perks = JSON.parse(a.perks); return { gems: a.gems, perks, ent: mkEnt(a.id, perks) }; };

// ---- payments ----
const credit = db.transaction((s) => {
  const pack = PACKS[Number(s.metadata?.pack)], acc = s.metadata?.account;
  if (!pack || !acc || s.amount_total !== pack.cents || s.currency !== CURRENCY) return;
  if (db.prepare('SELECT 1 FROM payments WHERE session_id=?').get(s.id)) return; // already credited
  if (!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(acc)) return;
  const pi = typeof s.payment_intent === 'string' ? s.payment_intent : null;
  db.prepare('INSERT INTO payments(session_id,account,gems,payment_intent,created) VALUES(?,?,?,?,?)').run(s.id, acc, pack.gems, pi, Date.now());
  db.prepare('UPDATE accounts SET gems=gems+? WHERE id=?').run(pack.gems, acc);
});
const claw = db.transaction((charge) => {
  if (!charge.refunded || !charge.payment_intent) return; // only full refunds
  const p = db.prepare('SELECT * FROM payments WHERE payment_intent=? AND refunded=0').get(charge.payment_intent);
  if (!p) return;
  db.prepare('UPDATE payments SET refunded=1 WHERE session_id=?').run(p.session_id);
  db.prepare('UPDATE accounts SET gems=MAX(0,gems-?) WHERE id=?').run(p.gems, p.account);
});

const app = express();
app.set('trust proxy', 1);
app.use(helmet());

// Stripe needs the raw body to verify the signature, so this route comes before express.json().
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send('Bad signature'); }
  try {
    const o = ev.data.object;
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      if (o.payment_status === 'paid') credit(o);
    } else if (ev.type === 'charge.refunded') claw(o);
    res.json({ received: true });
  } catch (e) { console.error(e); res.status(500).send('Retry'); } // Stripe retries on 5xx
});

app.use('/api', cors({ origin: env.CLIENT_ORIGIN }), express.json({ limit: '2kb' }), rateLimit({ windowMs: 60e3, limit: 120 }));

const ah = (f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);
function auth(req, res, next) {
  const [id, secret] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  const a = id && secret && db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (!a || !crypto.timingSafeEqual(sha(secret), Buffer.from(a.secret_hash, 'hex'))) return next(httpErr(401, 'Sign-in required'));
  req.acct = a; next();
}

app.post('/api/account', rateLimit({ windowMs: 3600e3, limit: 10 }), (req, res) => {
  const id = crypto.randomBytes(8).toString('hex'), secret = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO accounts(id,secret_hash,created) VALUES(?,?,?)').run(id, sha(secret).toString('hex'), Date.now());
  res.json({ token: `${id}.${secret}` });
});
app.get('/api/me', auth, (req, res) => res.json(view(req.acct)));

app.post('/api/checkout', auth, ah(async (req, res) => {
  const i = Number(req.body?.pack), pack = Number.isInteger(i) && PACKS[i];
  if (!pack) throw httpErr(400, 'Unknown gem pack');
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: pack.cents, product_data: { name: pack.name } } }],
    client_reference_id: req.acct.id,
    metadata: { account: req.acct.id, pack: String(i) },
    success_url: `${env.PUBLIC_URL}/thanks`,
    cancel_url: `${env.PUBLIC_URL}/cancelled`,
  });
  res.json({ url: session.url });
}));

const spend = db.transaction((id, perk) => {
  if (!Object.hasOwn(PERK_COST, perk)) throw httpErr(400, 'Unknown perk');
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id), perks = JSON.parse(a.perks);
  if ((perks[perk] || 0) >= PERK_MAX[perk]) throw httpErr(400, 'Already at the maximum');
  if (a.gems < PERK_COST[perk]) throw httpErr(402, 'Not enough gems');
  perks[perk] = (perks[perk] || 0) + 1;
  db.prepare('UPDATE accounts SET gems=gems-?, perks=? WHERE id=?').run(PERK_COST[perk], JSON.stringify(perks), id);
  return db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
});
app.post('/api/spend', auth, (req, res) => res.json(view(spend(req.acct.id, String(req.body?.perk)))));

// Called by whoever hosts a game room to learn which perks a joining player really owns.
app.post('/api/verify', (req, res) => {
  const d = readEnt(req.body?.ent);
  if (!d) return res.status(400).json({ error: 'Invalid or expired entitlement' });
  res.json({ perks: d.p });
});

const page = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:20px Georgia,serif;background:#161a26;color:#f0e6d0;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h1 style="color:#e8a33d">${title}</h1><p>${text}</p></div>`;
app.get('/thanks', (q, r) => r.send(page('Payment received', 'Close this tab and return to your game. Your gems will appear in a few seconds.')));
app.get('/cancelled', (q, r) => r.send(page('Checkout cancelled', 'No payment was taken. Close this tab and return to your game.')));
app.get('/healthz', (q, r) => r.send('ok'));

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});
app.listen(env.PORT || 3000, () => console.log('Dragonwall API listening'));
