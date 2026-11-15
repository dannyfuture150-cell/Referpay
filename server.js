require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { q, init } = require('./db');
const ps = require('./paystack');
const { FIRST_REFERRAL, SECOND_REFERRAL, CYCLE_BONUS, CYCLE_PEOPLE_PER_SIDE, MAX_LEVELS, REFERRALS_PER_COIN, COINS_PER_CASHOUT, COIN_CASHOUT } = require('./commissions');
// Most that sign-up can cost in rewards on average: the sponsor bonus plus pair bonuses for up to MAX_LEVELS members above
const REWARD_MAX = Math.round(FIRST_REFERRAL + (CYCLE_BONUS / (2 * CYCLE_PEOPLE_PER_SIDE)) * MAX_LEVELS);
const { normPhone, envNum, NETWORKS, now, balances, holdMs, createMember, completeSignup, processPayment, fulfill, refundPayout, withdraw, downlines, coinStatus, convertCoins, withdrawalTotals, requestWithdrawal, markPayoutPaid, submitSignupPayment, rejectSignup } = require('./core');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`)).replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PRICE = Math.round(envNum(process.env.PRODUCT_PRICE_GHS, 50) * 100);
const PAYOUT_MIN = Math.round(envNum(process.env.PAYOUT_MIN_GHS, 5) * 100);
const FEE = Math.round(envNum(process.env.WITHDRAW_FEE_GHS, 1) * 100); // Paystack charges GH₵1 per mobile money transfer; passed on to the member
// WhatsApp: support number (set SUPPORT_WHATSAPP to change it) and the channel link (set WHATSAPP_CHANNEL_URL).
const SUPPORT_WA = (() => {
  let n = String(process.env.SUPPORT_WHATSAPP || '0200835049').replace(/[\s\-().+]/g, '');
  if (n.startsWith('0')) n = '233' + n.slice(1); // wa.me needs the country code, so 0200835049 becomes 233200835049
  return /^\d{10,15}$/.test(n) ? n : '';
})();
const CHANNEL_URL = /^https:\/\/(www\.)?whatsapp\.com\//.test(process.env.WHATSAPP_CHANNEL_URL || '') ? process.env.WHATSAPP_CHANNEL_URL : '';
const REQUIRE_REF = process.env.REQUIRE_REFERRAL !== 'false';
// 'manual' = people send money to the merchant's MoMo number and the merchant approves by hand. 'paystack' = automatic.
const MODE = process.env.PAYMENT_MODE === 'paystack' ? 'paystack' : 'manual';
const MERCHANT = { name: process.env.MERCHANT_NAME || '', number: process.env.MERCHANT_NUMBER || '', network: process.env.MERCHANT_NETWORK || 'MTN' };
// Alerts the merchant by SMS (Arkesel) and/or email. Never blocks or breaks a request.
//  SMS (works on Render's free plan, sent over HTTPS): ARKESEL_API_KEY + ALERT_PHONE (+ ARKESEL_SENDER, a sender ID registered with Arkesel).
// Email alerts: Never blocks or breaks a request (callers do not wait for it).
//  Option A (works on Render's FREE plan): RESEND_API_KEY + ALERT_EMAIL. Sends over HTTPS and lands in your Gmail inbox.
//  Option B (needs a PAID Render plan, because Render's free plan blocks SMTP): EMAIL_USER + EMAIL_APP_PASSWORD (a Gmail app password).
const clean = (v) => String(v).replace(/[^\x20-\x7E]/g, '').slice(0, 20); // plain characters only, so the SMS stays one short message
async function notify(text, sms) {
  const phone = process.env.ALERT_PHONE;
  if (sms && process.env.ARKESEL_API_KEY && phone) {
    try {
      const num = phone.startsWith('0') ? '+233' + phone.slice(1) : phone;
      const r = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: process.env.ARKESEL_SENDER || 'ReferPay', message: sms, recipients: [num] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j.status && j.status !== 'success')) console.error('alert SMS failed:', r.status, JSON.stringify(j));
    } catch (e) { console.error('alert SMS failed:', e.message); }
  }
  const to = process.env.ALERT_EMAIL || process.env.EMAIL_USER;
  if (!to) return;
  const subject = 'ReferPay: ' + text.split('\n')[0];
  try {
    if (process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.EMAIL_FROM || 'ReferPay <onboarding@resend.dev>', to: [to], subject, text }),
      });
      if (!r.ok) console.error('alert email failed:', r.status, await r.text());
    } else if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000 });
      await t.sendMail({ from: `ReferPay <${process.env.EMAIL_USER}>`, to, subject, text });
    }
  } catch (e) { console.error('alert email failed:', e.message); }
}

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

/* ---------- auth helpers ---------- */
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function signToken(id) {
  const p = Buffer.from(JSON.stringify({ id, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return p + '.' + hmac(p);
}
function readToken(t) {
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const e = hmac(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d.id : null; }
  catch { return null; }
}
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
async function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + (await scrypt(pw, salt)).toString('hex');
}
async function checkPw(pw, stored) {
  try {
    const [salt, h] = String(stored).split(':');
    return crypto.timingSafeEqual(await scrypt(pw, salt), Buffer.from(h, 'hex'));
  } catch (e) { return false; }
}
const DUMMY_HASH = 'a'.repeat(32) + ':' + 'b'.repeat(128); // so an unknown phone number takes as long as a wrong password
// Best-effort per-instance limiter (serverless instances do not share memory). Withdrawals use a database limit instead.
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const k = req.ip + req.path, n = Date.now();
  if (hits.size > 5000) for (const [key, arr] of hits) if (!arr.length || n - arr[arr.length - 1] > 3600e3) hits.delete(key); // keep memory small
  const a = (hits.get(k) || []).filter((t) => n - t < windowMs);
  if (a.length >= max) return bad(res, 'Too many attempts. Try again later.', 429);
  a.push(n); hits.set(k, a); next();
};
const auth = (req, res, next) => {
  (async () => {
    const id = readToken((req.headers.authorization || '').replace('Bearer ', ''));
    const m = id && (await q('SELECT * FROM members WHERE id=$1', [id])).rows[0];
    if (!m) return bad(res, 'Please log in again.', 401);
    req.member = m; next();
  })().catch((e) => { console.error(e); bad(res, 'Something went wrong. Please try again.', 500); });
};
function adminAuth(req, res, next) {
  const k = String(req.headers['x-admin-key'] || '');
  if (!ADMIN_KEY || k.length !== ADMIN_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY))) return bad(res, 'Forbidden', 403);
  next();
}

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store'); // never let a browser cache account data
  next();
});
app.use(express.json({ limit: '50kb' }));
// The whole app is one page, index.html. It can sit next to server.js (flat upload) or inside a public/ folder.
const fs = require('fs');
const ADMIN_PAGE = path.join(__dirname, 'admin.html');
app.get('/admin', (req, res) => (fs.existsSync(ADMIN_PAGE) ? res.sendFile(ADMIN_PAGE) : res.status(404).send('admin.html is missing from the project.')));
const INDEX = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find((p) => fs.existsSync(p));
app.get('/', (req, res) => (INDEX ? res.sendFile(INDEX) : res.status(500).send('index.html is missing from the project.')));

// Make sure the app is configured and the tables exist before handling any API request.
app.use('/api', (req, res, next) => {
  if (SECRET.length < 16) return bad(res, 'Server is not configured: set SESSION_SECRET (16+ characters).', 500);
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return bad(res, 'Server is not configured: set DATABASE_URL.', 500);
  init().then(() => next()).catch((e) => { console.error('db init failed', e.message); bad(res, 'Database is not ready.', 500); });
});

app.use('/api/admin', limit(100, 600000)); // slows down anyone guessing the admin key
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/config', (_, res) => res.json({ price: PRICE, rewardMax: REWARD_MAX, mode: MODE }));

/* ---------- Paystack webhook ----------
   We never trust what the webhook says. It is only a nudge: we look the reference up in OUR database and then ask
   Paystack directly (with your secret key) what really happened. That is safe even though a serverless host does not
   give us the raw request body needed to check Paystack's signature. */
app.post('/api/paystack/webhook', wrap(async (req, res) => {
  const ev = req.body || {}, d = ev.data || {}, ref = String(d.reference || '');
  if (!ref) return res.sendStatus(200);
  if (ev.event === 'charge.success') {
    const known = (await q('SELECT 1 FROM signups WHERE reference=$1 UNION SELECT 1 FROM purchases WHERE reference=$1', [ref])).rows.length;
    if (known) {
      const v = await ps.verify(ref);
      if (v.status === 'success' && v.currency === 'GHS') await processPayment(ref, v.amount);
    }
  } else if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(ev.event)) {
    const p = (await q('SELECT * FROM payouts WHERE reference=$1', [ref])).rows[0];
    if (p) {
      const t = await ps.verifyTransfer(ref);
      if (t.status === 'success') await q("UPDATE payouts SET status='paid' WHERE id=$1 AND status='processing'", [p.id]);
      else if (['failed', 'reversed'].includes(t.status)) await refundPayout(p.id);
    }
  }
  res.sendStatus(200);
}));

/* ---------- accounts ---------- */
app.post('/api/signup', limit(10, 600000), wrap(async (req, res) => {
  const { name, email, password, network, side } = req.body || {};
  const phone = normPhone((req.body || {}).phone), ref = String((req.body || {}).ref || '').trim();
  if (!name || name.trim().length < 2 || name.trim().length > 60) return bad(res, 'Enter your name (2 to 60 characters).');
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return bad(res, 'Enter a valid email.');
  if (!/^0\d{9}$/.test(phone || '')) return bad(res, 'Enter a Ghana number like 0551234567.');
  if (!NETWORKS[network]) return bad(res, 'Choose your mobile money network.');
  if (!password || password.length < 8 || password.length > 100) return bad(res, 'Password must be 8 to 100 characters.');
  if ((await q('SELECT 1 FROM members WHERE phone=$1', [phone])).rows.length) return bad(res, 'That phone number is already registered.');
  let sponsor = null;
  if (ref) {
    sponsor = (await q('SELECT id FROM members WHERE code=$1 AND active=1', [String(ref).toUpperCase()])).rows[0];
    if (!sponsor) return bad(res, 'Invalid referral code.');
    if (side !== 'L' && side !== 'R') return bad(res, 'Choose Left or Right.');
  } else if (REQUIRE_REF && (await q('SELECT COUNT(*)::int AS c FROM members')).rows[0].c > 0) {
    return bad(res, 'A referral code is required to join.');
  }
  // Nothing is created yet. The details are saved and the person pays first.
  // The account is only created once Paystack confirms the payment (see completeSignup in core.js).
  if (MODE === 'manual' && !(MERCHANT.name && MERCHANT.number)) return bad(res, 'Payments are not set up yet. Please try again later.', 503);
  // Nothing is created yet. The details are saved and the person pays first.
  // The account is only created once the payment is confirmed (see completeSignup in core.js).
  // Tidy up sign-ups that were started but never paid for.
  await q("DELETE FROM signups WHERE status='pending' AND created < $1", [new Date(Date.now() - 7 * 864e5).toISOString()]);
  const passHash = await hashPw(password);
  let reference;
  for (let i = 0; ; i++) {
    reference = MODE === 'manual' ? 'RP' + crypto.randomInt(100000, 999999) : 'rs' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
    try {
      await q(`INSERT INTO signups(reference,name,email,phone,network,pass_hash,ref_code,side,amount,status,created)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [reference, name.trim(), email.trim(), phone, network, passHash, sponsor ? String(ref).toUpperCase() : null, sponsor ? side : null, PRICE, 'pending', now()]);
      break;
    } catch (e) { if (i > 4 || !/unique|23505/i.test(String(e.code || '') + e.message)) throw e; }
  }
  if (MODE === 'manual') return res.json({ manual: { reference, phone, amount: PRICE, name: MERCHANT.name, number: MERCHANT.number, network: MERCHANT.network } });
  const d = await ps.initialize({
    email: email.trim(), amount: PRICE, currency: 'GHS', reference,
    callback_url: BASE_URL + '/', metadata: { type: 'signup', phone },
  });
  res.json({ url: d.authorization_url });
}));

// MANUAL mode: the person says they have paid and gives their MoMo transaction ID. The merchant is alerted to approve.
app.post('/api/signup/paid', limit(20, 600000), wrap(async (req, res) => {
  const { reference, txnId } = req.body || {};
  const t = String(txnId || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(t)) return bad(res, 'Enter the transaction ID from your MoMo confirmation message.');
  const r = await submitSignupPayment(String(reference || ''), t, (req.body || {}).phone);
  if (r.code === 'unknown') return bad(res, 'Payment reference not found.', 404);
  if (r.code === 'closed') return bad(res, 'This payment has already been handled.');
  if (r.code === 'dup') return bad(res, 'That transaction ID has already been used.');
  notify(`New payment to confirm\nName: ${r.signup.name}\nMoMo: ${r.signup.phone} (${r.signup.network})\nAmount: GH₵${r.signup.amount / 100}\nReference: ${r.signup.reference}\nTransaction ID: ${t}\nCheck your MoMo, then approve in the admin page.`,
    `ReferPay: GHS ${r.signup.amount / 100} payment to confirm from ${clean(r.signup.name)} ${r.signup.phone}. MoMo ID ${t}. Approve in admin.`);
  res.json({ ok: true });
}));

// Needs the reference AND the phone number used to sign up (so nobody can look up other people's payments).
// If the person never entered their transaction ID, this also returns the payment details so they can carry on.
app.get('/api/signup/status', limit(60, 600000), wrap(async (req, res) => {
  const s = (await q('SELECT status,phone,amount FROM signups WHERE reference=$1', [String(req.query.reference || '')])).rows[0];
  if (!s || s.phone !== normPhone(req.query.phone)) return bad(res, 'Unknown payment.', 404);
  const manual = s.status === 'pending' && MODE === 'manual'
    ? { reference: String(req.query.reference), phone: s.phone, amount: s.amount, name: MERCHANT.name, number: MERCHANT.number, network: MERCHANT.network } : undefined;
  res.json({ status: s.status, manual });
}));

// Called when the customer returns from Paystack after paying to sign up. Verifies the payment with Paystack
// and creates the account if the webhook has not already done so.
app.get('/api/signup/complete', limit(30, 600000), wrap(async (req, res) => {
  const reference = String(req.query.reference || '');
  const s = (await q('SELECT status FROM signups WHERE reference=$1', [reference])).rows[0];
  if (!s) return bad(res, 'Unknown signup.', 404);
  if (s.status !== 'completed') {
    const d = await ps.verify(reference);
    if (d.status !== 'success' || d.currency !== 'GHS') return bad(res, 'Payment was not completed. Please try again.', 402);
    const r = await completeSignup(reference, d.amount);
    if (!r.ok) return bad(res, r.reason === 'conflict'
      ? 'That phone number was registered while you were paying. Please contact support for a refund.'
      : 'Payment could not be confirmed.', 409);
  }
  res.json({ ok: true });
}));

app.post('/api/login', limit(15, 600000), wrap(async (req, res) => {
  const password = String((req.body || {}).password || '').slice(0, 100);
  const m = (await q('SELECT * FROM members WHERE phone=$1', [normPhone((req.body || {}).phone)])).rows[0];
  if (!(await checkPw(password, m ? m.pass_hash : DUMMY_HASH)) || !m) return bad(res, 'Wrong phone number or password.', 401);
  res.json({ token: signToken(m.id) });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const m = req.member;
  const [balance, dl, history, payouts, coins, withdrawn, ann] = await Promise.all([
    balances(m.id),
    downlines(m.id),
    q(`SELECT l.kind,l.amount,l.level,l.created,s.name AS src FROM ledger l
       LEFT JOIN members s ON s.id=l.src_id WHERE l.member_id=$1 ORDER BY l.id DESC LIMIT 100`, [m.id]),
    q('SELECT id,amount,fee,status,created FROM payouts WHERE member_id=$1 ORDER BY id DESC LIMIT 20', [m.id]),
    coinStatus(m.id),
    withdrawalTotals(m.id),
    q('SELECT id,message,created FROM announcements ORDER BY id DESC LIMIT 5'),
  ]);
  res.json({
    id: m.id, name: m.name, code: m.code, active: !!m.active, balance: balance.available, pendingAmount: balance.pending, holdHours: holdMs() / 3600e3, mode: MODE,
    price: PRICE, payoutMin: PAYOUT_MIN, fee: FEE, rewards: { first: FIRST_REFERRAL, second: SECOND_REFERRAL, cycle: CYCLE_BONUS, perSide: CYCLE_PEOPLE_PER_SIDE, max: REWARD_MAX },
    bonus: { stage: m.bonus_stage, cycles: m.cycles_paid,
      leftNew: Math.max(0, m.left_active - m.base_left - m.cycles_paid * CYCLE_PEOPLE_PER_SIDE),
      rightNew: Math.max(0, m.right_active - m.base_right - m.cycles_paid * CYCLE_PEOPLE_PER_SIDE) },
    downlines: dl, history: history.rows, payouts: payouts.rows,
    support: { whatsapp: SUPPORT_WA, channelUrl: CHANNEL_URL },
    announcements: ann.rows, withdrawn, coins, coinRules: { referralsPerCoin: REFERRALS_PER_COIN, coinsPerCashout: COINS_PER_CASHOUT, cashout: COIN_CASHOUT },
  });
}));

/* ---------- payments ---------- */
// Pay the one-time activation fee. Paying it activates the account and pays the rewards to the members above.
app.post('/api/checkout', auth, wrap(async (req, res) => {
  if (req.member.active) return bad(res, 'Your account is already active.');
  const reference = 'rp' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  await q('INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,$2,$3,$4,$5)', [req.member.id, reference, PRICE, 'pending', now()]);
  const d = await ps.initialize({
    email: req.member.email, amount: PRICE, currency: 'GHS', reference,
    callback_url: BASE_URL + '/', metadata: { member_id: req.member.id, type: 'activation' },
  });
  res.json({ url: d.authorization_url });
}));

// "I already paid": checks this member's unfinished payments with Paystack and activates them if one succeeded.
app.post('/api/activation/check', auth, wrap(async (req, res) => {
  const pend = (await q("SELECT reference FROM purchases WHERE member_id=$1 AND status='pending' ORDER BY id DESC LIMIT 5", [req.member.id])).rows;
  for (const p of pend) {
    const d = await ps.verify(p.reference).catch(() => null);
    if (d && d.status === 'success' && d.currency === 'GHS') await fulfill(p.reference, d.amount);
  }
  const m = (await q('SELECT active FROM members WHERE id=$1', [req.member.id])).rows[0];
  res.json({ active: !!m.active });
}));

app.get('/api/verify', auth, wrap(async (req, res) => {
  const reference = String(req.query.reference || '');
  const p = (await q('SELECT * FROM purchases WHERE reference=$1 AND member_id=$2', [reference, req.member.id])).rows[0];
  if (!p) return bad(res, 'Unknown payment.', 404);
  const d = await ps.verify(reference);
  if (d.status === 'success' && d.currency === 'GHS') await fulfill(reference, d.amount);
  res.json({ status: (await q('SELECT status FROM purchases WHERE id=$1', [p.id])).rows[0].status });
}));

/* ---------- withdrawals (instant, from your Paystack balance) ---------- */
app.post('/api/payout', auth, wrap(async (req, res) => {
  const recent = (await q('SELECT COUNT(*)::int AS c FROM payouts WHERE member_id=$1 AND created > $2',
    [req.member.id, new Date(Date.now() - 3600e3).toISOString()])).rows[0].c;
  if (recent >= 10) return bad(res, 'Too many withdrawals this hour. Please try again later.', 429);
  const gross = Math.round(Number((req.body || {}).amount) * 100);
  const r = MODE === 'manual'
    ? await requestWithdrawal(req.member.id, gross, { fee: FEE, min: PAYOUT_MIN })
    : await withdraw(req.member.id, gross, { ps, fee: FEE, min: PAYOUT_MIN });
  if (r.code === 'min') return bad(res, `Minimum withdrawal is GH₵${PAYOUT_MIN / 100}.`);
  if (r.code === 'inactive') return bad(res, 'Activate your account first.');
  if (r.code === 'balance') return bad(res, 'Not enough balance.');
  if (r.code === 'pending') return bad(res, 'Your newest earnings can be withdrawn 24 hours after you earn them. Try a smaller amount or come back later.');
  if (!r.ok) return bad(res, 'Withdrawals are temporarily unavailable. Your balance is safe. Please try again later.', 503);
  if (MODE === 'manual') {
    notify(`Withdrawal request\nName: ${req.member.name}\nMoMo: ${req.member.phone} (${req.member.network})\nSend: GH₵${(gross - FEE) / 100} (GH₵${gross / 100} minus GH₵${FEE / 100} fee)\nSend it by MoMo, then tap Mark as paid in the admin page.`,
      `ReferPay: send GHS ${(gross - FEE) / 100} to ${clean(req.member.name)} ${req.member.phone} (${req.member.network}). Then mark paid in admin.`);
  }
  res.json({ ok: true, id: r.id, status: r.status, received: gross - FEE });
}));

app.post('/api/coins/convert', auth, wrap(async (req, res) => {
  const r = await convertCoins(req.member.id);
  if (r.code === 'inactive') return bad(res, 'Activate your account first.');
  if (!r.ok) return bad(res, `You need at least ${COINS_PER_CASHOUT} coins to convert.`);
  res.json({ ok: true, amount: r.amount });
}));

// ---- Announcements: posted from the admin page, shown at the top of every member's Home page ----
app.get('/api/admin/announcements', adminAuth, wrap(async (req, res) => {
  res.json((await q('SELECT id,message,created FROM announcements ORDER BY id DESC LIMIT 20')).rows);
}));
app.post('/api/admin/announcements', adminAuth, wrap(async (req, res) => {
  const message = String((req.body || {}).message || '').trim();
  if (!message) return bad(res, 'Write a message first.');
  if (message.length > 500) return bad(res, 'Keep it under 500 characters.');
  await q('INSERT INTO announcements(message,created) VALUES($1,$2)', [message, now()]);
  res.json({ ok: true });
}));
app.post('/api/admin/announcements/:id/delete', adminAuth, wrap(async (req, res) => {
  const r = await q('DELETE FROM announcements WHERE id=$1', [Number(req.params.id)]);
  if (r.rowCount !== 1) return bad(res, 'That announcement is already gone.', 404);
  res.json({ ok: true });
}));

// ---- Merchant admin (MANUAL mode) ----
app.get('/api/admin/pending', adminAuth, wrap(async (req, res) => {
  const signups = (await q("SELECT id,reference,name,phone,network,amount,txn_id,created FROM signups WHERE status='submitted' ORDER BY id")).rows;
  const payouts = (await q(`SELECT p.id,p.amount,p.fee,p.created,m.name,m.phone,m.network FROM payouts p
    JOIN members m ON m.id=p.member_id WHERE p.status='pending' ORDER BY p.id`)).rows;
  res.json({ signups, payouts });
}));
app.post('/api/admin/signups/:id/approve', adminAuth, wrap(async (req, res) => {
  const s = (await q('SELECT * FROM signups WHERE id=$1', [Number(req.params.id)])).rows[0];
  if (!s || s.status !== 'submitted') return bad(res, 'This payment is not waiting for approval.', 409);
  const r = await completeSignup(s.reference, s.amount);
  if (!r.ok) return bad(res, r.reason === 'conflict' ? 'That phone number is already registered. Refund this person by hand.' : r.reason === 'noref' ? 'This person signed up without a referral code, so they cannot join an existing network. Reject it and refund them.' : 'Could not approve this payment.', 409);
  res.json({ ok: true });
}));
app.post('/api/admin/signups/:id/reject', adminAuth, wrap(async (req, res) => {
  if (!(await rejectSignup(Number(req.params.id)))) return bad(res, 'This payment is not waiting for approval.', 409);
  res.json({ ok: true });
}));
app.post('/api/admin/payouts/:id/paid', adminAuth, wrap(async (req, res) => {
  if (!(await markPayoutPaid(Number(req.params.id)))) return bad(res, 'This withdrawal is not waiting.', 409);
  res.json({ ok: true });
}));
app.post('/api/admin/payouts/:id/reject', adminAuth, wrap(async (req, res) => {
  const p = (await q('SELECT status FROM payouts WHERE id=$1', [Number(req.params.id)])).rows[0];
  if (!p || p.status !== 'pending') return bad(res, 'This withdrawal is not waiting.', 409);
  await refundPayout(Number(req.params.id)); // gives the money back to the member's balance
  res.json({ ok: true });
}));

app.get('/api/admin/conflicts', adminAuth, wrap(async (req, res) => {
  res.json((await q("SELECT reference,name,phone,amount,created FROM signups WHERE status='conflict'")).rows);
}));

// Recent withdrawals, so you can watch for failures.
app.get('/api/admin/payouts', adminAuth, wrap(async (req, res) => {
  res.json((await q(`SELECT p.id,p.amount,p.fee,p.status,p.created,m.name,m.phone,m.network
    FROM payouts p JOIN members m ON m.id=p.member_id ORDER BY p.id DESC LIMIT 100`)).rows);
}));

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`ReferPay running on ${BASE_URL}`));
