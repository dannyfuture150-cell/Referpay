const assert = require('assert');
const { FIRST_REFERRAL, SECOND_REFERRAL, CYCLE_BONUS, CYCLE_PEOPLE_PER_SIDE, MAX_LEVELS } = require('./commissions');

// 1. Plan constants (always run)
assert.deepStrictEqual([FIRST_REFERRAL, SECOND_REFERRAL, CYCLE_BONUS, CYCLE_PEOPLE_PER_SIDE, MAX_LEVELS], [500, 500, 300, 2, 20]);
console.log('reward plan tests passed');

// 2. Database tests. They need a SEPARATE, EMPTY Postgres database and WIPE it, so never point this at your live one.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) { console.log('Skipping database tests. To run them: TEST_DATABASE_URL=<a separate empty test database> npm test'); process.exit(0); }
if (testUrl === process.env.DATABASE_URL) { console.error('TEST_DATABASE_URL must not be your live DATABASE_URL.'); process.exit(1); }
process.env.DATABASE_URL = testUrl;

const { q, init, pool } = require('./db');
const { fulfill, balanceOf, balances, downlines, refundPayout, place, createMember, completeSignup, processPayment, withdraw, coinStatus, convertCoins, withdrawalTotals, requestWithdrawal, markPayoutPaid, submitSignupPayment, rejectSignup, normPhone, envNum } = require('./core');

(async () => {
  process.env.REWARD_HOLD_HOURS = '0'; // the main scenarios ignore the waiting period; it is tested separately at the end
  await init();
  await q('TRUNCATE payouts, ledger, purchases, signups, members RESTART IDENTITY CASCADE');
  let n = 0, ref = 0;
  // Test helper: creates a member directly in the tree (active by default, as if they had already paid).
  const mk = async (name, sponsor, side, active = 1) => {
    const spot = sponsor ? await place(q, sponsor, side) : { parentId: null, side: null };
    return (await q(`INSERT INTO members(name,email,phone,network,pass_hash,code,parent_id,sponsor_id,side,active,created)
      VALUES($1,$2,$3,'MTN','x',$4,$5,$6,$7,$8,'now') RETURNING id`, [name, name + '@x.com', '0' + (500000000 + ++n), name + n, spot.parentId, sponsor, spot.side, active])).rows[0].id;
  };
  const buy = async (m) => {
    const r = 'r' + ++ref;
    await q("INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,$2,5000,'pending','now')", [m, r]);
    return fulfill(r, 5000);
  };
  const at = async (id) => (await q('SELECT parent_id AS p, side AS s FROM members WHERE id=$1', [id])).rows[0];

  // Placement and spillover
  const A = await mk('A', null), B = await mk('B', A, 'L'), C = await mk('C', A, 'R');
  const D = await mk('D', A, 'L'), E = await mk('E', A, 'L'), F = await mk('F', A, 'L');
  assert.deepStrictEqual([(await at(B)).p, (await at(B)).s], [A, 'L']);
  assert.deepStrictEqual([(await at(C)).p, (await at(C)).s], [A, 'R']);
  assert.deepStrictEqual([(await at(D)).p, (await at(D)).s], [B, 'L']);  // A's left is full, D spills under B
  assert.deepStrictEqual([(await at(E)).p, (await at(E)).s], [B, 'R']);
  assert.deepStrictEqual([(await at(F)).p, (await at(F)).s], [D, 'L']);

  // New plan: GH₵5 first referral, GH₵5 for one on the other side, then GH₵3 per 2 new left + 2 new right
  const P = await mk('P', null);
  const P1 = await mk('P1', P, 'L'), P2 = await mk('P2', P, 'R');
  await buy(P1);                                                      // r1
  assert.strictEqual(await balanceOf(P), 500);                       // first referral pays GH₵5
  const P3 = await mk('P3', P, 'L');                                  // joins P's left, spills under P1
  await buy(P3);                                                      // r2
  assert.strictEqual(await balanceOf(P), 500);                       // same side again: no second bonus yet
  await buy(P2);                                                      // r3
  assert.strictEqual(await balanceOf(P), 1000);                      // other side: second GH₵5 (total GH₵10)
  assert.strictEqual((await fulfill('r3', 5000)).already, true);     // a retry of the same payment does nothing
  assert.strictEqual(await balanceOf(P), 1000);
  const P4 = await mk('P4', P, 'L'), P5 = await mk('P5', P, 'L'), P6 = await mk('P6', P, 'R'), P7 = await mk('P7', P, 'R');
  await buy(P4); await buy(P5);                                       // 2 new on the left
  assert.strictEqual(await balanceOf(P), 1000);                      // nothing on the right yet: no pair bonus
  await buy(P6);
  assert.strictEqual(await balanceOf(P), 1000);
  await buy(P7);                                                      // r7: 2 new on each side, though P did not refer them directly under him
  assert.strictEqual(await balanceOf(P), 1300);                      // pair bonus GH₵3
  assert.strictEqual((await q('SELECT cycles_paid AS n FROM members WHERE id=$1', [P])).rows[0].n, 1);
  assert.strictEqual((await fulfill('r7', 5000)).already, true);
  assert.strictEqual(await balanceOf(P), 1300);                      // no double payment
  assert.strictEqual(await balanceOf(P1), 0);                        // P1 was not the sponsor and has no bonuses of its own
  // The first paying referral can sit deep in the tree and still pays the sponsor
  const Q = await mk('Q', null), Q1 = await mk('Q1', Q, 'L'), Q2 = await mk('Q2', Q, 'L'), Q3 = await mk('Q3', Q, 'R');
  await buy(Q2);
  assert.strictEqual(await balanceOf(Q), 500);
  await buy(Q1);                                                      // same side as the first: no second bonus
  assert.strictEqual(await balanceOf(Q), 500);
  await buy(Q3);                                                      // the other side
  assert.strictEqual(await balanceOf(Q), 1000);
  await q("INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,'again',5000,'pending','now')", [Q3]);
  await fulfill('again', 5000);                                       // a second payment by the same member pays nothing
  assert.strictEqual(await balanceOf(Q), 1000);
  assert.strictEqual((await fulfill('nope', 5000)).ok, false);
  await q("INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,'low',5000,'pending','now')", [F]);
  assert.strictEqual((await fulfill('low', 4000)).ok, false);        // underpaid is rejected

  // Downlines combined, with sides
  const dl = await downlines(A);
  assert.strictEqual(dl.length, 5);
  assert.strictEqual(dl.filter((d) => d.leg === 'L').length, 4);
  assert.strictEqual(dl.filter((d) => d.leg === 'R').length, 1);
  assert.deepStrictEqual([dl.find((d) => d.name === 'D').parent_id, dl.find((d) => d.name === 'D').side], [B, 'L']);  // tree position is returned
  assert.ok(dl.find((d) => d.name === 'D').direct);              // A sponsored D even though D sits under B
  assert.ok(!(await downlines(B)).find((d) => d.name === 'D').direct);

  // Only ACTIVATED members earn: an unpaid member above the buyer is skipped, the paid one still gets paid
  const X = await mk('X', null, null, 0);                         // signed up, has not paid yet
  const Y = await mk('Y', X, 'L'); const W = await mk('W', Y, 'L');
  await buy(W);
  assert.strictEqual(await balanceOf(Y), 500);                   // level 1, active: paid
  assert.strictEqual(await balanceOf(X), 0);                     // level 2, NOT active: nothing
  assert.strictEqual((await q("SELECT COUNT(*)::int AS c FROM ledger WHERE kind IN ('reward','bonus','cycle') AND src_id=$1", [W])).rows[0].c, 1);

  // A new member starts inactive and becomes active only when payment is confirmed
  const hasPhone = async (p) => (await q('SELECT 1 FROM members WHERE phone=$1', [p])).rows.length > 0;
  const cur = await createMember({ name: 'Newbie', email: 'n@x.com', phone: '0244000001', network: 'MTN', passHash: 'h', sponsorId: C, side: 'R' });
  assert.ok(cur.id && (await hasPhone('0244000001')));
  const nb = (await q('SELECT * FROM members WHERE id=$1', [cur.id])).rows[0];
  assert.deepStrictEqual([nb.active, nb.parent_id, nb.side, nb.sponsor_id], [0, C, 'R', C]);
  const cBefore = await balanceOf(C), aBefore = await balanceOf(A);
  assert.strictEqual((await buy(cur.id)).ok, true);              // pays the activation fee
  assert.strictEqual((await q('SELECT active FROM members WHERE id=$1', [cur.id])).rows[0].active, 1);
  assert.strictEqual((await balanceOf(C)) - cBefore, 500);       // C's first referral: GH₵5
  assert.strictEqual((await balanceOf(A)) - aBefore, 0);         // A is higher up and not the sponsor: nothing yet
  const dup = await createMember({ name: 'Twin', email: 't@x.com', phone: '0244000001', network: 'MTN', passHash: 'h', sponsorId: C, side: 'R' });
  assert.strictEqual(dup.error, 'phone');                         // same phone number is refused
  const [p3, p4] = await Promise.all([                            // two people joining at the same moment get different spots
    createMember({ name: 'P3', email: 'p3@x.com', phone: '0244000003', network: 'MTN', passHash: 'h', sponsorId: C, side: 'L' }),
    createMember({ name: 'P4', email: 'p4@x.com', phone: '0244000004', network: 'MTN', passHash: 'h', sponsorId: C, side: 'L' })]);
  assert.ok(p3.id && p4.id);
  const spots = (await q('SELECT parent_id, side FROM members WHERE id IN ($1,$2)', [p3.id, p4.id])).rows.map((r) => r.parent_id + r.side);
  assert.strictEqual(new Set(spots).size, 2);

  // Pay first: the account does not exist until the payment is confirmed
  const su = (r, name, phone, code, side) => q(`INSERT INTO signups(reference,name,email,phone,network,pass_hash,ref_code,side,amount,status,created)
    VALUES($1,$2,$3,$4,'MTN','hash',$5,$6,5000,'pending','now')`, [r, name, name + '@x.com', phone, code, side]);
  const codeOf = async (id) => (await q('SELECT code FROM members WHERE id=$1', [id])).rows[0].code;
  await su('s1', 'Payer', '0244000011', await codeOf(C), 'R');
  assert.strictEqual(await hasPhone('0244000011'), false);
  assert.strictEqual((await completeSignup('s1', 4000)).ok, false);    // underpaid: still no account
  assert.strictEqual(await hasPhone('0244000011'), false);
  assert.strictEqual((await processPayment('s1', 5000)).ok, true);
  const pm = (await q("SELECT * FROM members WHERE phone='0244000011'")).rows[0];
  assert.strictEqual(pm.active, 1);                                     // active straight away
  assert.strictEqual(pm.sponsor_id, C);
  const rewardsFor = async (id) => (await q("SELECT COUNT(*)::int AS c FROM ledger WHERE kind IN ('reward','bonus','cycle') AND src_id=$1", [id])).rows[0].c;
  const pr = await rewardsFor(pm.id);
  assert.strictEqual((await completeSignup('s1', 5000)).ok, true);     // return-page retry: nothing doubles
  assert.strictEqual((await q("SELECT COUNT(*)::int AS c FROM members WHERE phone='0244000011'")).rows[0].c, 1);
  assert.strictEqual(await rewardsFor(pm.id), pr);
  await su('s2', 'Twin', '0244000011', await codeOf(C), 'R');           // same phone paid twice: flagged for a refund
  assert.strictEqual((await completeSignup('s2', 5000)).reason, 'conflict');
  assert.strictEqual((await q("SELECT status FROM signups WHERE reference='s2'")).rows[0].status, 'conflict');
  await su('s3', 'P3', '0244000013', await codeOf(C), 'L'); await su('s4', 'P4', '0244000014', await codeOf(C), 'L');
  const both = await Promise.all([completeSignup('s3', 5000), completeSignup('s4', 5000)]);
  assert.ok(both.every((r) => r.ok));                                   // two people paying at once both get an account
  const sp = (await q("SELECT parent_id, side FROM members WHERE phone IN ('0244000013','0244000014')")).rows.map((r) => r.parent_id + r.side);
  assert.strictEqual(new Set(sp).size, 2);

  // Pair bonuses only count people within the nearest 20 levels
  const TOP = await mk('TOP', null);
  let prev = TOP; const chain = [];
  for (let i = 0; i < 25; i++) { prev = await mk('N' + i, prev, 'L'); chain.push(prev); }
  await buy(prev);
  const lc = async (id) => (await q('SELECT left_active AS l FROM members WHERE id=$1', [id])).rows[0].l;
  assert.strictEqual(await lc(chain[24 - 20]), 1);                    // 20 levels above the buyer: counted
  assert.strictEqual(await lc(chain[24 - 21]), 0);                    // 21 levels above: not counted
  assert.strictEqual(await lc(TOP), 0);

  // Coins: every 3 paid people sponsored with your code = 1 coin; 3 coins = GH₵5
  let cs = await coinStatus(A);
  assert.deepStrictEqual([cs.referrals, cs.earned, cs.available], [5, 1, 1]);        // B C D E F were sponsored by A
  assert.strictEqual((await convertCoins(A)).code, 'coins');                         // 1 coin is not enough
  await mk('U1', A, 'L', 0);                                                          // someone who has not paid does not count
  for (const nme of ['S1', 'S2', 'S3', 'S4']) await mk(nme, A, 'R');                  // these spill under other members
  cs = await coinStatus(A);
  assert.deepStrictEqual([cs.referrals, cs.earned, cs.available, cs.nextIn], [9, 3, 3, 3]);
  const coinBefore = await balanceOf(A);
  const cv = await convertCoins(A);
  assert.deepStrictEqual([cv.ok, cv.amount], [true, 500]);                            // 3 coins -> GH₵5
  assert.strictEqual(await balanceOf(A), coinBefore + 500);
  cs = await coinStatus(A);
  assert.deepStrictEqual([cs.available, cs.converted], [0, 3]);
  assert.strictEqual((await convertCoins(A)).code, 'coins');                          // nothing left, no double cash-out
  const V = await mk('V', null, null, 0);
  assert.strictEqual((await convertCoins(V)).code, 'inactive');

  // Payout hold + refund keeps balances whole, and never refunds a paid withdrawal
  await q("INSERT INTO payouts(member_id,amount,status,created) VALUES($1,1000,'processing','now')", [B]);
  const pid = (await q('SELECT MAX(id)::int AS id FROM payouts')).rows[0].id;
  await q("INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,'payout_hold',-1000,$2,'now')", [B, 'hold:' + pid]);
  const mid = await balanceOf(B); await refundPayout(pid); await refundPayout(pid);
  assert.strictEqual(await balanceOf(B), mid + 1000);
  await q("INSERT INTO payouts(member_id,amount,status,created) VALUES($1,1000,'paid','now')", [B]);
  const paidId = (await q('SELECT MAX(id)::int AS id FROM payouts')).rows[0].id;
  const b2 = await balanceOf(B); await refundPayout(paidId);
  assert.strictEqual(await balanceOf(B), b2);

  await q("INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,'reward',4000,'manual:a','2020-01-01T00:00:00.000Z')", [A]); // funds for the withdrawal tests
  // Instant withdrawals (Paystack is faked here)
  const opts = (ps) => ({ ps, fee: 100, min: 500 });
  let recipients = 0; const sent = [];
  const okPs = { recipient: async () => { recipients++; return { recipient_code: 'RCP_1' }; },
    transfer: async (b) => { sent.push(b); return { status: 'success' }; }, verifyTransfer: async () => { throw new Error('not found'); } };
  const start = await balanceOf(A);
  assert.strictEqual((await withdraw(A, 300, opts(okPs))).code, 'min');
  assert.strictEqual((await withdraw(A, start + 100, opts(okPs))).code, 'balance');
  const w1 = await withdraw(A, 500, opts(okPs));
  assert.strictEqual(w1.ok, true);
  assert.strictEqual(await balanceOf(A), start - 500);
  assert.strictEqual(sent[0].amount, 400);                                          // GH₵5 minus the GH₵1 fee is sent
  assert.strictEqual((await q('SELECT status FROM payouts WHERE id=$1', [w1.id])).rows[0].status, 'paid');
  await withdraw(A, 500, opts(okPs));
  assert.strictEqual(recipients, 1);                                                // recipient is created once and reused
  const afterOk = await balanceOf(A);
  const failPs = { ...okPs, transfer: async () => { throw new Error('insufficient balance'); } };
  assert.strictEqual((await withdraw(A, 500, opts(failPs))).ok, false);             // Paystack refuses: money comes back
  assert.strictEqual(await balanceOf(A), afterOk);
  const otpPs = { ...okPs, transfer: async () => ({ status: 'otp' }) };
  assert.strictEqual((await withdraw(A, 500, opts(otpPs))).ok, false);
  assert.strictEqual(await balanceOf(A), afterOk);
  const unsurePs = { ...okPs, transfer: async () => { throw new Error('network'); }, verifyTransfer: async () => ({ status: 'pending' }) };
  assert.strictEqual((await withdraw(A, 500, opts(unsurePs))).ok, true);            // may have been sent: NOT refunded
  const afterUnsure = await balanceOf(A);
  assert.strictEqual(afterUnsure, afterOk - 500);
  const [x, y] = await Promise.all([withdraw(A, afterUnsure, opts(okPs)), withdraw(A, afterUnsure, opts(okPs))]);
  assert.strictEqual([x, y].filter((r) => r.ok).length, 1);                         // two clicks can only spend it once
  assert.strictEqual(await balanceOf(A), 0);
  const U = await mk('U', null, null, 0);                                           // an unpaid member cannot withdraw
  await q("INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,'reward',1000,'manual:u','2020-01-01T00:00:00.000Z')", [U]);
  assert.strictEqual((await withdraw(U, 500, opts(okPs))).code, 'inactive');

  // Manual mode: the payer gives a MoMo transaction ID and the merchant approves
  await su('m1', 'Manu', '0244000021', await codeOf(C), 'L');
  assert.strictEqual((await submitSignupPayment('m1', 'TX1234567', '0244000021')).ok, true);
  await su('m2', 'Dup', '0244000022', await codeOf(C), 'L');
  assert.strictEqual((await submitSignupPayment('m2', 'TX1234567', '0244000022')).code, 'dup');     // the same MoMo ID can't be used twice
  assert.strictEqual((await submitSignupPayment('nope', 'ABC12345', '0244000022')).code, 'unknown');
  assert.strictEqual((await submitSignupPayment('m2', 'TX5555555', '0244999999')).code, 'unknown'); // wrong phone: can't touch someone else's payment
  assert.strictEqual((await q("SELECT status FROM signups WHERE reference='m1'")).rows[0].status, 'submitted');
  assert.strictEqual(await hasPhone('0244000021'), false);                             // nothing exists before approval
  assert.strictEqual((await completeSignup('m1', 5000)).ok, true);                    // merchant approves
  assert.strictEqual(await hasPhone('0244000021'), true);
  assert.strictEqual((await submitSignupPayment('m2', 'TX7654321', '+233 24 400 0022')).ok, true);   // +233 and spaces are accepted
  assert.strictEqual(await rejectSignup((await q("SELECT id FROM signups WHERE reference='m2'")).rows[0].id), true);
  assert.strictEqual((await completeSignup('m2', 5000)).reason, 'rejected');          // a rejected payment can't be approved later
  assert.strictEqual(await hasPhone('0244000022'), false);
  // A sign-up with no referral code cannot start a second tree once the network exists
  await su('nr', 'NoRef', '0244000031', null, null);
  assert.strictEqual((await completeSignup('nr', 5000)).reason, 'noref');
  assert.strictEqual(await hasPhone('0244000031'), false);
  // Phone numbers and blank settings
  assert.strictEqual(normPhone('+233 55 123 4567'), '0551234567');
  assert.strictEqual(normPhone('233551234567'), '0551234567');
  assert.strictEqual(normPhone('055-123-4567'), '0551234567');
  assert.strictEqual(normPhone('0551234567'), '0551234567');
  assert.deepStrictEqual([envNum('', 24), envNum(undefined, 1), envNum('0', 24), envNum('5', 1)], [24, 1, 0, 5]);
  // Manual withdrawals: held, then paid by hand or refunded
  const MW = await mk('MW', null);
  await q("INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,'reward',2000,'manual:mw','2020-01-01T00:00:00.000Z')", [MW]);
  const rq = await requestWithdrawal(MW, 1000, { fee: 100, min: 500 });
  assert.strictEqual(rq.ok, true);
  assert.strictEqual(await balanceOf(MW), 1000);                                       // GH₵10 held straight away
  assert.strictEqual(await markPayoutPaid(rq.id), true);                              // merchant sent it and marks it paid
  assert.strictEqual(await markPayoutPaid(rq.id), false);                             // can't be marked twice
  const rq2 = await requestWithdrawal(MW, 500, { fee: 100, min: 500 });
  await refundPayout(rq2.id);                                                          // merchant rejects: money returns
  assert.strictEqual(await balanceOf(MW), 1000);
  assert.strictEqual((await requestWithdrawal(MW, 5000, { fee: 100, min: 500 })).code, 'balance');
  const wt = await withdrawalTotals(MW);
  assert.deepStrictEqual([wt.paid, wt.received, wt.waiting], [1000, 900, 0]);          // only the paid one counts, not the refunded one
  await requestWithdrawal(MW, 500, { fee: 100, min: 500 });
  const wt2 = await withdrawalTotals(MW);
  assert.deepStrictEqual([wt2.paid, wt2.waiting], [1000, 500]);                         // a new request shows as waiting

  // Next-day rule: new rewards cannot be withdrawn until the waiting period has passed
  process.env.REWARD_HOLD_HOURS = '24';
  const G = await mk('G', null), H = await mk('H', G, 'L');
  await buy(H);                                                    // G earns GH₵5 right now
  let b = await balances(G);
  assert.deepStrictEqual([b.total, b.pending, b.available], [500, 500, 0]);
  assert.strictEqual((await withdraw(G, 500, opts(okPs))).code, 'pending');       // too soon
  assert.strictEqual(await balanceOf(G), 500);
  await q("UPDATE ledger SET created='2020-01-01T00:00:00.000Z' WHERE member_id=$1 AND kind IN ('reward','bonus','cycle')", [G]);
  b = await balances(G);
  assert.deepStrictEqual([b.total, b.pending, b.available], [500, 0, 500]);
  assert.strictEqual((await withdraw(G, 500, opts(okPs))).ok, true);
  assert.strictEqual(await balanceOf(G), 0);
  process.env.REWARD_HOLD_HOURS = '0';

  console.log('All database tests passed');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
