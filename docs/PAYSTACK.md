# Paystack today: how money moves, what works, what is missing

Audit for issue #90 (part of the Paystack project, epic #89). **Documentation only: nothing in the code was changed.**
Written from reading the code on `main`; where something was not checked it says so. Line numbers are for `main` on the
day of writing and will drift.

## In plain words

- Most orders are paid **outside the app** (bank transfer, then the buyer taps "I've paid" and the vendor confirms). Paystack
  is used for: the **₦999 monthly listing fee**, the **monthly billing / commission settlement** for vendors, a **card
  checkout for an order** that is still reachable from the app, **bank-account checks and vendor "subaccounts"**, and
  **payouts and refunds** that an admin starts.
- The live app calls the **Vercel functions** in `api/` (same address as the site). The backend on Heroku has copies of them
  (`medris-backend/src/modules/payments`, `vendor-payments`, `orders/payout-actions.service.ts`), but nothing in
  `medris-frontend/src` calls those copies today (only `/api/...` paths are used). Check this again before the switch in #95.
- Today's card checkout for an order is a **split payment**: the vendor's share goes straight to their bank through a Paystack
  subaccount (`api/initiate-payment.js:46`), so the money is **not held** by Levromart. The epic's "hold, then pay out" is
  therefore a **change** in behaviour, not a rename.
- Biggest gaps: no record of Paystack events (duplicates and out-of-order events are not tracked), the webhook only handles
  `charge.success`, payment amounts are not compared with Paystack's, payout transfers use a reference that changes on every
  try, and nothing checks Paystack against the database later.

## Flows end to end

Amounts are `numeric` naira in the database; kobo only at the Paystack call (`Math.round(amount * 100)`).

### 1. Order card payment (`api/initiate-payment.js`, `api/verify-payment.js`, webhook)

1. Browser (`01-app/78-quantity-suggestions.js:368`) → `POST /api/initiate-payment { orderId, accessToken }`.
2. The function calls the database function **`create_payment_intent`** with the buyer's own token
   (`initiate-payment.js:21-26`), so the database checks that the order is the buyer's and decides the amount. Returns
   `reference` and `amount`. Reference format: **`medris_<uuid without dashes>`** (the backend copy shows it,
   `medris-backend/src/modules/payment-claims/payment-claims.service.ts:393`).
3. Reads the buyer's email and the vendor's `paystack_subaccount_code` (service role), then **`POST /transaction/initialize`**
   (`initiate-payment.js:49`) with `amount` in kobo, `callback_url = <origin>/?paid=1&reference=…&orderId=…` and, when the
   vendor has a subaccount, `subaccount` (the split).
4. Buyer pays on Paystack and returns to the app. `88-modal-back-button-outside-click-dismissa.js:173` calls
   **`GET /api/verify-payment?reference=`** → Paystack **`GET /transaction/verify/<reference>`** (`verify-payment.js:15`) →
   if `data.status === "success"`, `settleReference` (`api/_util.js:46`). Anyone who knows a reference can call this endpoint
   (it only asks Paystack, it does not check who is calling).
5. Paystack also calls the webhook (`api/paystack-webhook.js`), which ends in the same `settleReference`.
6. `settleReference` for a `medris_…` reference does `PATCH payments?provider_reference=eq.<ref>` → `status=paid, paid_at`
   (`_util.js:94`). The order moves on through database triggers/functions (not read in full here).

Failure cases: Paystack timeout in step 3 → the function returns 500/400 and the buyer retries; a **new** intent is created
by `create_payment_intent` each time (not checked whether it reuses an open one). Webhook never arrives → the browser's
verify call is the only other path; if the buyer never returns, the payment stays pending until someone checks by hand
(there is no job).

### 2. Commission settlement (vendor pays owed commission)

`api/vendor-payments.js` (init at `:651`) → RPC `create_commission_payment_intent` (`:566`) → `transaction/initialize`;
reference **`commission_…`**. Return page calls `/api/verify-payment` (`88-…js:194`) or the webhook calls `settleReference`:
sets `commission_settlements` to `paid` and then **every** `commission_charges` row of that vendor with `status=owed` to
`paid` (`_util.js:51-65`), without comparing the amount paid with the charges, so a charge created after checkout started would
be marked paid too.

### 3. Monthly billing (vendor card on file) — `api/vendor-payments.js:734-960`

Reference **`billing_<random><time>`** (`:879`). `transaction/initialize` at `:931`. On success `settleReference` stores
`paystack_authorization_code` and `paystack_customer_code` on the vendor and sets `monthly_billing_status=active` (`_util.js:67-92`).

### 4. ₦999 listing fee — `api/vendor-payments.js:1010-1480`, webhook `:25-45`

Init at `:1298`, verify at `:1480`. The webhook activates the exact listing when metadata `purpose = levromart_listing_monthly`,
`status = success` and `amount === 99900` kobo (`paystack-webhook.js:8, 28-37`) via `settleListingPayment`, which is idempotent
(already-active listings are left alone, `:73-80`) and checks the reference matches the listing's pending reference (`:82`).
Errors from its `PATCH` calls are checked; the `listing_payment_intents` update is deliberately best-effort.

### 5. Vendor bank account and subaccount — `api/vendor-payments.js:285-430`

`GET /bank/resolve` (`:362`) to check an account, then **`POST /subaccount`** (`:393`) with the vendor's `commission_pct`.
The code is stored as `paystack_subaccount_code`. No transfer recipient is created here (that happens lazily, flow 6).

### 6. Payout to vendor (admin "release") — `api/order-payout-action.js:58`, `api/_util.js:142`

`releaseOrderPayout(orderId)`: order must have `payout_status = held`; sums paid `sale_price`/`rental_fee` and `deposit`
payments; payout = fee × (1 − commission_pct/100) + deposit (JavaScript floating point, no rounding rule written down);
creates a **transfer recipient** if missing (`_util.js:112`, **`POST /transferrecipient`**), then **`POST /transfer`**
(`_util.js:170`, `source: "balance"`) with reference **`payout_<orderId>_<Date.now()>`**; on success marks the order
`payout_status = released` and **`status = completed`**. The bank account number is read from the vendor row.

Failure cases: Paystack error → thrown, the order stays `held`. **Timeout with unknown outcome → the admin retries and a
second transfer with a new reference can be sent** (the reference changes every try). The OTP-on-transfer setting of the
Paystack account can also block it (the code's comment says so).

### 7. Refund — `api/order-payout-action.js:110`, `api/_util.js:233`

`refundOrderPayout`: refuses only if `payout_status = refunded`; refunds the first paid payment's reference **in full**
(**`POST /refund { transaction }`**, no amount), then sets `payout_status = refunded` and `status = cancelled`. For a
split-payment order the refund comes out of Levromart's own balance (the code comment says so). Buyer-cancel
(`order-payout-action.js:165`) and vendor-decline (`:230`) are related paths (not read in full).

### 8. Webhook — `api/paystack-webhook.js`, backend copy `payments.service.ts:65`

Signature: HMAC-SHA512 of the raw body. The Vercel version compares with `!==` (`paystack-webhook.js:16`, not constant time);
the backend copy uses `timingSafeEqual` (`medris-backend/src/integrations/paystack.ts:92-97`). Only `charge.success` is
handled; every other event gets `200` and is ignored. There is no stored event id, so a repeat is handled again (the
settlement code is mostly idempotent by checking `status === "paid"`, but order payments are patched blindly).

## Events

| Event | Handled today? |
|---|---|
| `charge.success` | Yes (webhook and verify), see flows 1 to 4 |
| `transfer.success`, `transfer.failed`, `transfer.reversed` | **No.** A transfer's final result is never read; the order is marked released when Paystack accepts the request |
| `refund.processed`, `refund.failed` | **No** |
| `charge.dispute.create`, `.remind`, `.resolve` | **No** |

## Payments review checklist (from `.agent/rules/payments-edge-cases.md`)

| Item | Status | Where |
|---|---|---|
| Duplicate initiation | **Gap / not checked.** Each tap calls `create_payment_intent`; reuse of an open attempt not confirmed | `initiate-payment.js:21` → #95 |
| Duplicate or reordered webhooks | **Gap.** No event log; no state machine | `paystack-webhook.js:23` → #94 |
| Timeout with unknown outcome | **Gap.** Payout reference changes each try; no look-up before retry | `_util.js:178` → #92, #98 |
| Amount and currency checked against Paystack | **Partly.** Only the ₦999 listing compares the amount (`paystack-webhook.js:36`). Orders, commission and billing do not | `_util.js:46` → #94, #95 |
| Signature verification | **Handled** (Vercel uses non-constant-time compare) | `paystack-webhook.js:16`, `paystack.ts:92` → #92 |
| Refund vs dispute | **Gap.** Full refund only, no amount, no dispute event | `_util.js:233` → #99 |
| Concurrent confirmations of one order | **Not checked** (verify and webhook can run together; both patch the same row) | `_util.js:94` → #94 |
| Commission recorded exactly once | **Not checked** for payouts; commission settlement marks all `owed` charges paid | `_util.js:63` → #98, #100 |
| Payout/transfer identity and failure recovery | **Gap.** Unstable reference, no result event, no retry state | `_util.js:170-178` → #98 |
| Client retry storms | **Not checked** (no rate limit seen on these functions) | — |
| Sensitive data in logs or responses | **Not checked.** Errors return Paystack's message to the browser | all |
| Reconciliation when a webhook never arrives | **Gap.** None; only the buyer returning triggers verify | → #94, #101 |

## Environment variables (names only)

Used by the Paystack code: `PAYSTACK_SECRET_KEY` (Vercel functions and backend), `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` (Vercel functions read and write the database with the service role). The backend validates
`PAYSTACK_SECRET_KEY` in `medris-backend/src/config/env.ts`. No public key is used by the frontend.

URLs the code expects:
- Webhook (dashboard): the Vercel function `/api/paystack-webhook` (the backend has `/api/paystack-webhook` as well). Which one
  is set in the Paystack dashboard was **not checked**; #91 asks the login holder to write it down.
- Callbacks: `<origin>/?paid=1&reference=…&orderId=…` (orders), `?commissionPaid=1&reference=…`, and listing/billing returns
  handled in `vendor-payments.js` (callback URLs at `:673`, `:958`, `:1321`).

## Gap list and the issue that fixes each

| Gap | Fixed in |
|---|---|
| Paystack calls spread over many `fetch`es; non-constant-time signature compare in Vercel code; no kobo helper | #92 |
| No tables for attempts, events, payouts, refunds | #93 |
| Webhook: only `charge.success`; no event log; no reordering rules; amount/currency not checked for orders, commission, billing; no reconciliation job | #94 |
| Card checkout for orders is a split payment, not hold-then-pay-out; no reuse of an open attempt; verify endpoint is unauthenticated | #95, #96 |
| Bank accounts: free-text bank fields; subaccount per vendor instead of a verified transfer recipient | #97 |
| Payout: reference not stable (double transfer risk), floating-point amount, result never read, no retries or holds | #98 |
| Refund: full only, no amount, no dispute/chargeback handling | #99 |
| Listing fee, billing and commission on the old functions | #100 |
| No admin view of money, no daily check against Paystack | #101 |

## Not checked in this audit

The bodies of the database functions (`create_payment_intent`, `create_commission_payment_intent`, the payment-claim
functions) and the triggers that move an order after `payments.status = paid`; the full `buyerCancel` and `vendorDecline`
paths; `api/vendor-payments.js` beyond the Paystack calls; whether the Paystack dashboard webhook points at Vercel or at the
backend; Paystack account settings (transfers, OTP).

---

## The new webhook (issue #94): `POST /api/v1/payments/paystack/webhook`

Added next to the old one; **the old webhook (`/api/paystack-webhook`, Vercel and its backend copy) keeps working until the URL
in the Paystack dashboard is switched** (Paystack allows one URL per mode). Before switching, migration 0005 (the ledger tables,
issue #93) must be applied to the database.

What it does, in order:
1. Reads the **raw body** and checks `x-paystack-signature` (HMAC-SHA512, constant time). Invalid or missing: `401`, nothing stored.
2. Builds an **event key** (`<event>:<Paystack's own id>`, or a hash of the body) and, in one database transaction, takes a lock on
   that key and records the event in `paystack_events`. If it was already processed the answer is `200` and nothing happens, even
   when two copies arrive at the same moment.
3. `charge.success`: asks Paystack to **verify** the payment first (before opening the transaction) and never trusts the event's
   amount. If the payment is in `paystack_transactions`, the amount in kobo and the currency must match what was recorded; if not,
   nothing is settled, the event is stored as `amount_mismatch` and admins get an alert. If it is not in the ledger (a payment
   started by today's Vercel functions), it is settled exactly like the old webhook: ₦999 listing activation, otherwise commission,
   billing or order payment (`settleReference`).
4. `transfer.success|failed|reversed` update `vendor_payouts` by `transfer_reference`; `refund.processed|failed` update
   `paystack_refunds`; `charge.dispute.create|remind|resolve` alert admins and, on `create`, put the order's **pending** payouts on
   hold. A failed or reversed transfer and a failed refund alert admins. Unknown events are stored and answered `200`.
5. If the verify call cannot finish (timeout, Paystack down) the event is stored **unprocessed** and answered `200`; the
   reconciliation job settles it. If something else goes wrong the answer is `500`, the reason is stored on the event, and
   Paystack sends it again.

### State machine (a record only moves forward; anything else is stored as "ignored: out of order")

| Record | Allowed moves |
|---|---|
| Payout | pending → processing, success, failed, reversed, on_hold · processing → success, failed, reversed, on_hold · **success → reversed** (the bank took it back) · failed and reversed are final · on_hold → any (an admin decides) |
| Payment attempt | initialized → success, failed, abandoned · failed, abandoned → success (a late success) · success → refunded, partially_refunded |
| Refund | pending → processing, processed, failed · processing → processed, failed · failed → processed · processed is final |

Examples: `transfer.success` after `transfer.reversed` is ignored; `transfer.reversed` after `transfer.success` is applied; a second
`charge.success` for a settled payment is a duplicate.

Not done here (later issues): moving the **order** itself on `refund.processed` (#99), creating payouts and sending transfers (#98),
notifying vendors about payouts (#98).

### Reconciliation job: `paystack-reconcile`

For a webhook that never arrives. Every 10 minutes it asks Paystack about payments left `initialized` for more than 15 minutes and
payouts left `processing` for more than 30, and settles them the way the webhook would have, using the **same event key**, so a
webhook that arrives later is a duplicate. A call that cannot be answered is left for the next run. Safe to run as often as you like.

- It is a backend job (`POST /api/v1/jobs/paystack-reconcile`, header `x-cron-secret: <CRON_SECRET>`). It is **not** in pg_cron.
  Schedule it with Heroku Scheduler (`*/10 * * * *`) calling that URL, or run it by hand the same way.
- Answer: `{ "job": "paystack-reconcile", "result": { "payments": n, "payouts": n, "settled": n, "problems": n } }`.

---

## Paying for an order with Paystack (issue #95)

Behind the switch **`PAYSTACK_CHECKOUT_ENABLED`** (a Heroku config var, default `false`). While it is off, the initialize endpoint
answers `404 feature_disabled`, `GET /api/v1/payments/config` says `paystackCheckout: false`, and nothing else changes.

- `POST /api/v1/orders/{orderId}/paystack/initialize` (the order's buyer only). The amount comes **only from the database**: what is
  outstanding on the order (the whole total for pay-before, the delivery deposit for pay-after-delivery, then the exact balance
  after delivery), plus **Paystack's fee, which the buyer pays** (founder's decision on #89). Answer:
  `{ authorizationUrl, accessCode, reference, amountNaira (what the buyer pays), feeNaira, orderAmountNaira }`.
  A double tap gets the same link back; if the order's amount changed, the old attempt is abandoned and a new one started; two
  taps at the same moment leave one open attempt. Reference: `lvm_ord_<8 characters of the order id>_<16 random hex>`.
- `GET /api/v1/payments/paystack/{reference}` (the payer or an admin): while the payment is open, asks Paystack and settles it
  through **the same steps and event key as the webhook**, so whichever arrives first wins and the other is a duplicate. Answer
  `{ status, orderStatus }`.
- When Paystack confirms: the payment row is marked paid, the order moves on with the same rules as a vendor-confirmed bank transfer
  (a delivery deposit confirms the order; a final payment completes it or starts the buyer's 24-hour confirmation; an order never
  moves back a step), the vendor is told "Order paid: deliver now" and the buyer "Payment received".
- An order with an open or paid Paystack attempt cannot also be reported as a bank transfer (`payment-report` answers 400).

### The fee (assumption to confirm)

`integrations/paystack/fees.ts` gives the total so that Levromart receives the order amount in full after Paystack's fee: **1.5% +
₦100, the ₦100 waived below ₦2,500, capped at ₦2,000**. These are Paystack's published local rates as I know them; I could not open
paystack.com/pricing from the build environment. **Check them against the pricing page and the dashboard before go-live (#103);**
change them in that one file. The fee rounds up to the next kobo, so Levromart is never short.

### Not covered here

The checkout screen (#96), payouts to vendors (#98), refunds (#99). Orders already paid through the old Vercel functions are
unchanged.
