// Reward plan. All amounts are in pesewas (100 pesewas = GH₵1).
//  1. FIRST REFERRAL:  GH₵5 when the first person you referred (with your code) pays.
//  2. SECOND REFERRAL: GH₵5 more when a person you referred pays on your OTHER side (so GH₵10 in total).
//  3. PAIR BONUS:      from then on, GH₵3 every time 2 NEW people join your left side AND 2 NEW people join your right
//                      side, even if you did not refer them. (Spillover and deeper members count.)
// Pair bonuses count people within the nearest MAX_LEVELS levels below you, which keeps the cost per sign-up bounded.
const FIRST_REFERRAL = 500;
const SECOND_REFERRAL = 500;
const CYCLE_BONUS = 300;
const CYCLE_PEOPLE_PER_SIDE = 2;
const MAX_LEVELS = Number(process.env.REWARD_MAX_LEVELS || 20);

// Coins: every 3 people who join with YOUR code (paid members you sponsored, wherever they end up in the tree)
// earns you 1 coin. 3 coins convert to GH₵5.
const REFERRALS_PER_COIN = 3;
const COINS_PER_CASHOUT = 3;
const COIN_CASHOUT = 500; // pesewas = GH₵5

module.exports = { FIRST_REFERRAL, SECOND_REFERRAL, CYCLE_BONUS, CYCLE_PEOPLE_PER_SIDE, MAX_LEVELS, REFERRALS_PER_COIN, COINS_PER_CASHOUT, COIN_CASHOUT };
