# ReferPay (Node.js + Postgres + Paystack, Ghana) for free Render + Neon

Binary (left/right) referral platform. A new person **pays the one-time GH₵50 joining fee as part of signing up**
(mobile money or card, via Paystack). Their account is only created after Paystack confirms the payment, so
nobody can look around before paying. Paying activates the account and rewards the active members above them,
all the way to the top. Only active members earn rewards, sponsor new people, or withdraw.

The sign-up form tells people plainly where the GH₵50 goes: up to GH₵20 is paid out as rewards to members above
them, and the rest covers platform costs and running the business. Keep that description truthful. Do not call
the fee only "maintenance" if most of it funds rewards, because that is misleading and can break
consumer-protection law and Paystack's rules.

Rewards (members must be active, which means they have paid):
- **First referral:** GH₵5 when the first person you referred with your code pays.
- **Second referral:** another GH₵5 when someone you referred pays on your **other** side (GH₵10 in total).
- **Pair bonus:** after that, GH₵3 every time **2 new people join your left side and 2 new people join your right side**,
  even if you did not refer them. People anywhere below you count (spillover and deeper members), but only those within the
  nearest 20 levels (`REWARD_MAX_LEVELS`), which keeps the cost per sign-up bounded.

Members see all their downlines combined. New earnings can be **withdrawn 24 hours after they are earned** (set
`REWARD_HOLD_HOURS`, 0 = no wait). After that they can **withdraw any amount (from GH₵5) at any time** to their
mobile money, straight from your Paystack balance. The waiting period gives Paystack time to settle sign-up
payments into your balance before rewards leave it. Rewards are paid on real product purchases, never on sign-ups alone.

## Read this first: the free setup is for TESTING
- **Render's free web service goes to sleep** after about 15 minutes with no visitors and takes about a minute to wake.
  Paystack confirmations can then arrive late (the sign-up return page still completes sign-ups).
- Check Render's and Neon's current terms and limits before using free plans for a paid business.
- Move to a paid always-on plan before real members' money is involved.

## 1. Create the free database (Neon)
1. Sign up at neon.tech and create a project. Copy the **pooled** connection string (it starts with `postgres://`).
2. Keep it secret. This is your `DATABASE_URL`. The tables are created automatically on the first request.

## 2. Deploy on Render
1. Unzip this project and upload it to a **GitHub** repository (do not upload a `.env` file; on a phone, select all the unzipped FILES in the Upload files screen).
2. On render.com choose **New, Blueprint** and pick the repo (it reads `render.yaml`), or choose **New, Web Service**
   and set: Runtime Node, Build `npm install`, Start `npm start`, Instance type **Free**.
3. Set these environment variables:
   - `DATABASE_URL`: your Neon string
   - `PAYSTACK_SECRET_KEY`: your `sk_test_...` key
   - `SESSION_SECRET` and `ADMIN_KEY`: long random strings (the Blueprint generates them; view them in the Environment tab)
   - `NODE_VERSION`: `20`
   - optional: `REWARD_HOLD_HOURS`, `PRODUCT_PRICE_GHS`, `PAYOUT_MIN_GHS`, `WITHDRAW_FEE_GHS`, `REQUIRE_REFERRAL`, `REWARD_MAX_LEVELS`
4. When Render gives you your address (like `https://referpay.onrender.com`), you do not need to set `BASE_URL`
   (the app reads Render's address), but you can set it if you use your own domain.
5. Open your address. Sign up the **first member** without a referral code and pay the GH₵50 (a test payment in test
   mode). They are the top of your tree and can then give out their referral code. After that, everyone needs a code.
   After that, everyone needs a referral code.

## 3. Paystack settings
1. Settings, API Keys & Webhooks: set the webhook URL to `https://YOUR-ADDRESS/api/paystack/webhook`.
2. Enable **Transfers**, turn on **Manual Payouts** (so collected money stays in your Paystack Balance), and turn
   **off** "Confirm transfers before sending" (the transfer OTP), or every withdrawal will fail.
3. Keep enough in your Paystack Balance to cover what members are owed. Confirm Paystack's current settlement
   rules with them. Never spend money members can still withdraw.
4. Switch from `sk_test_...` to your live key only after testing a full sign-up and a withdrawal in test mode.

## 4. How it stays safe
- **The webhook is never trusted.** It only tells the server a payment happened. The server then asks Paystack
  directly (with your secret key) whether it really succeeded, and for the real amount.
- **Money is a ledger in Postgres** (`ledger` table, in pesewas). A withdrawal locks the member's row, takes the
  money off their balance first, then sends the transfer. If Paystack refuses, the money goes back automatically.
  Two quick taps can't spend the same balance twice.
- Everything is safe to run twice (webhook retries, the return page): rewards are created only once.
- Withdrawals are limited to 10 per member per hour.
- Watch for problems: `curl -H "x-admin-key: YOUR_ADMIN_KEY" https://YOUR-ADDRESS/api/admin/payouts`
  and `/api/admin/conflicts` (two people who paid to register the same phone number; refund the second in Paystack)

## Manual payment mode (default, no Paystack needed)
Until a payment provider approves you, the app runs in **manual mode** (`PAYMENT_MODE=manual`):
- **Joining:** after the form, the person sees **your name and MoMo number** (`MERCHANT_NAME`, `MERCHANT_NUMBER`,
  `MERCHANT_NETWORK`) and a reference like RP123456. They send GH₵50, enter the MoMo **transaction ID**, and wait.
  You get an alert and approve it in the admin page. Only then is their account created and the rewards paid.
- **Withdrawing:** a member asks to withdraw. The amount is taken off their balance, you get an alert, you send the
  money by MoMo (the amount shown, after the fee), then tap **Mark as paid**. **Reject** gives the money back.
- **Admin page:** `https://YOUR-ADDRESS/admin`. Enter your `ADMIN_KEY`. It lists payments to confirm and withdrawals to send,
  and has an **Announcements** box: whatever you post (up to 500 characters) appears at the top of every member's Home page,
  newest first, and you can delete old ones.
- **SMS alerts to your phone (optional):** you get a short text for every new payment to confirm and every withdrawal
  request. Sign up at arkesel.com, create an API key (HTTP API, API Keys), register a **sender ID** (a name up to 11
  characters, like ReferPay), and buy a little SMS credit (check their current prices and free test credits). In Render set
  `ARKESEL_API_KEY`, `ARKESEL_SENDER` (your registered sender ID) and `ALERT_PHONE` (your number, e.g. 0551234567).
  It sends over HTTPS, so it works on Render's free plan. If the SMS doesn't arrive, check Render's Logs for "alert SMS failed".
- **Alerts to your Gmail (optional, can be used as well):** you get an email for every new payment to confirm and every withdrawal request.
  - **Option A, works on Render's free plan:** sign up at resend.com using your Gmail address, create an API key, and set
    `RESEND_API_KEY` and `ALERT_EMAIL` (the same Gmail address you signed up with). Until you verify a domain, Resend only
    delivers to your own account address, which is exactly what you need. Free limit: 100 emails a day. The first alerts may land in
    Spam, so mark them as not spam.
  - **Option B, Gmail directly:** turn on 2-Step Verification on your Google account, create an App Password
    (myaccount.google.com, Security, App passwords), and set `EMAIL_USER` (your Gmail) and `EMAIL_APP_PASSWORD`.
    **Render's free plan blocks the ports Gmail uses (465 and 587), so this only works on a paid Render plan.**
  - Without either option, just open `/admin` often.
- **Staying safe:** approve only after the money and the same transaction ID show in your own MoMo app, never from a
  screenshot. Each transaction ID can only be used once. Mark a withdrawal paid only after you have sent it.
  Keep your admin key private. Everyone's money sits in your wallet, so keep what members are owed separate from yours.
- **Later:** when Paystack approves you, set `PAYMENT_MODE=paystack` and add `PAYSTACK_SECRET_KEY`. Payments and withdrawals then become automatic.

## WhatsApp channel and support
The Home page has a **Join our WhatsApp channel** button (set `WHATSAPP_CHANNEL_URL` to your channel link, which looks like
`https://whatsapp.com/channel/...`; leave it blank to hide the button) and a **Contact support on WhatsApp** button that opens a
chat with `SUPPORT_WHATSAPP` (default 0200835049) with the member's name and referral code already typed in.

## Coins
Every **3 paid people who join with a member's own code** earns that member **1 coin**, even if those people end up
under someone else in the tree. **3 coins convert to GH₵5** (button on the Home page). Coins are worked out from
the member's own referrals, so they can't get out of step, and converted cash follows the same 24-hour wait. Change the
numbers in `commissions.js` (`REFERRALS_PER_COIN`, `COINS_PER_CASHOUT`, `COIN_CASHOUT`). Nine referrals earn GH₵5,
so this costs little next to the rewards.

## 5. Change the rewards
Edit `commissions.js`: `FIRST_REFERRAL`, `SECOND_REFERRAL`, `CYCLE_BONUS` (pesewas, 300 = GH₵3),
`CYCLE_PEOPLE_PER_SIDE` (2), and `MAX_LEVELS` (also set by `REWARD_MAX_LEVELS`, default 20). Product price: `PRODUCT_PRICE_GHS`.

**Check your margins.** Every sign-up can complete a pair bonus for each member above it (within 20 levels), so on average
each sign-up costs up to about GH₵3 / 4 = GH₵0.75 per level above it, up to about GH₵15 over 20 levels, plus up to GH₵5
for the sponsor: **about GH₵20 of each GH₵50**, and the cost per sign-up rises as the network gets deeper. Lowering
`REWARD_MAX_LEVELS` lowers the cap. A daily cap on pair bonuses per member is also common; ask if you want one added.

## 6. Run the tests
`npm install`, then create a SEPARATE empty Postgres database (a Neon branch works) and run:
`TEST_DATABASE_URL=postgres://... npm test`. The tests wipe that database, so never use your live one.

## 7. Before you launch
- Test everything in Paystack test mode first, including a withdrawal. Confirm the mobile money network codes
  (`MTN`, `VOD`, `ATL`) in `core.js` against Paystack's docs.
- Paystack's rules list some multi-level marketing and matrix programs as ineligible businesses. Be open with them
  about how the plan works, sell a real product, and get a Ghanaian lawyer to review it. Do not promise income.
- Add a privacy policy and terms, and keep database backups.
