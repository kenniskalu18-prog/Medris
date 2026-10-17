# What the real schema revealed (14 Oct 2026)

Building every test database from the exported production structure (`medris-backend/src/database/baseline/`) instead
of the earlier approximation surfaced the problems below. Each one was reproduced on a local PostgreSQL 17.6 loaded with
that structure; **nothing was run against production**. "Live" means the problem affects the app people use today.

| # | Severity | Where | Problem | Status |
|---|---|---|---|---|
| S1 | **High, live** | database | Anyone can read every pending account appeal (name, email, suspension reason) | needs a migration (approval) |
| S2 | **High, live** | database | Anyone can send any user a notification, which is also emailed and pushed | needs a migration (approval) |
| S3 | Medium, live | database | 41 privileged functions run for visitors who are not signed in, without checking who calls | review list below |
| S4 | Medium, live | database | Signed out, anyone can rewrite or delete a recent chat message, end or re-ring a call, or dispute an order | **fixed in the new backend** |
| S5 | **High, live** | database | Either side of a chat can rewrite any message in it, including the other person's, at any time | **fixed in the new backend**; live fix needs a migration (approval) |
| S6 | Medium, live | database | A shop can switch off comments (or hide likes) on another shop's listing, and the real owner cannot undo it | **fixed in the new backend**; live fix needs a migration (approval) |
| S8 | **High, live** | database | A buyer can post a review on any shop using any of their own completed orders (e.g. a 1-star review of a competitor) | **fixed in the new backend**; live fix needs a migration (approval) |
| S9 | **High, live** | database | A suspended user can lift their own suspension; an admin can make themselves super admin | **fixed in the new backend**; live fix needs a migration (approval) |
| S10 | **High, live** | database | A buyer or a shop can rewrite an order directly (total, delivery fee, payout status...), and a buyer can create an order at any price | backend has no such endpoint; live fix needs a migration (approval) |
| S11 | **Critical, live** | database | A shop applicant can mark their own shop verified (skipping admin review), and an owner can change any shop field: lift admin pauses, set their own rating | **fixed in the new backend**; live fix needs a migration (approval) |
| S12 | **High, live** | database | Anyone, signed out too, can read every verified shop's bank account, Paystack codes (including the saved card authorization) and ID documents | **fixed in the new backend**; live fix needs a migration (approval) |
| S14 | Medium, live | live updates | Typing, presence and call-signalling channels are open to anyone who knows the conversation or call id: they can watch typing, read a call's connection details (including IP addresses) or hang a call up, and claim to be anyone | **fixed in the new backend** (`/api/v1/live` rooms) |
| S13 | **High, live** | database | Monthly listing fees are enforced only in the browser: a shop can put a monthly listing live without paying, or extend its paid period; a package can bundle another shop's products | **fixed in the new backend**; live fix needs a migration (approval) |
| S7 | Medium, live | database | Package comments can be posted under any name and photo (e.g. "Levromart Support"); comment authors can rename themselves later | **fixed in the new backend**; live fix needs a migration (approval) |
| B1 | **High, live** | `api/delete-account.js` | "Delete account" fails for every user | **fixed in this change** |
| B2 | High, latent | database | Card payment for an order would charge twice the price | **fixed in the new backend**; not reachable today |
| B3 | Medium, live | `api/order-payout-action.js` | Admin "Release payout" (disputes queue) cannot work | decision needed |
| B4 | Low | `api/order-payout-action.js` | "mark-manual" payout always fails | not called by the app |
| B5 | Low, live | sign-up | "Referral applied" message never appears | small frontend fix |
| B8 | Medium, live | database | "Add a new sector" (vendor catalogue) always fails | **fixed in the new backend** (not live until the switch) |
| B9 | Low, live | database | A buyer cannot report a service-booking payment a second time (e.g. to correct it) | **fixed in the new backend** |
| B10 | Medium, live | database | Admin "Restore vendor" fails for any shop that had packages | **fixed in the new backend** |
| B11 | **High, live** | database | The daily listing-billing job fails as soon as any monthly listing is due: no renewal reminders, expired listings stay live | **fixed in the new backend** |
| B15 | Low, live | comments | Package comments never update live (the table was never added to Realtime) | **fixed in the new backend** (migration 0004 + `/api/v1/live`) |
| B13 | Medium, live | support requests | Photos attached to a support request are uploaded but never linked to it, so admins never see them | **fixed in the new backend** |
| B14 | Low, live | admin carousel | "Publish bundled banners" always fails | **fixed in the new backend** |
| B12 | Low, live | admin dashboard | "Open disputes" on the admin dashboard always shows 0 | **fixed in the new backend** |
| B6 | Medium | new backend | Database messages replaced by a generic "values not valid" / "not allowed" | **fixed** |
| B7 | Medium | new backend | Error responses could contain the SQL query and its values | **fixed** |
| M1 | High (blocking) | migration 0005 (since removed) | Would have stopped on production; retiring the table would also break account deletion | **fixed**; PR needs label `migration-edit` |
| C1 | Low | database | Overlapping triggers doing the same job twice | clean-up later |
| C2 | Question | Storage | Buckets `champion-cvs` / `champion-photos` are not Levromart's | ask the founder |
| C4 | Low, latent | database | Adding or re-pricing a variety outside "save varieties" fails | backend keeps to the batch path |
| C3 | Low | migration 0005 (since removed) | The retired `inventory` table stays in the Realtime publication | moot: 0005 removed |

## Security

**S1 - `admin_get_pending_appeals()`** is `SECURITY DEFINER`, has no admin check, and is granted to `anon` and
`authenticated`. With the public anon key (shipped in every browser) anyone can call
`POST /rest/v1/rpc/admin_get_pending_appeals` and receive the name, email, suspension reason and message of every user
with a pending appeal. Fix: add `if not public.is_admin() then raise exception ... using errcode = '42501'` and revoke
`execute` from `anon`. The admin screen calls it as an admin, so it keeps working.

**S2 - `create_notification(user_id, ...)`** inserts a notification for any user with any title, text and link, for
any caller including visitors who are not signed in. Every notification row is forwarded by the trigger
`notify_email_on_notification` to `/api/notify`, which emails and pushes it: a stranger can send official-looking
Levromart messages to any account (user ids are visible on public vendor pages). `notify_admins()`,
`notify_rank_upsert()` and `notify_comment_mentions()` have the same shape. Fix: revoke `execute` from `anon`; for
`authenticated`, either require `p_actor_id = auth.uid()` and restrict the types a user may create, or move the one
browser call (`09-part.js`, comment notification) to a dedicated function. Database triggers and the backend
(`service_role`) keep their access.

**S3 - other `SECURITY DEFINER` functions open to `anon` that never check the caller** (41; some are intended, e.g.
the public counters and password-reset steps). Worth a decision each:

- quota and counters for another user: `increment_chat_usage(uuid,int)`, `increment_tts_usage(uuid,int,int)` (Levi
  limits can be used up for someone else);
- scheduled jobs anyone can trigger early: `auto_complete_eligible_orders()`, `escalate_unresolved_payment_orders()`,
  `process_payment_unresolved_escalations()`, `process_commission_deadline_reminders()`,
  `process_listing_billing_reminders()`, `send_background_reminders()`, `rls_auto_enable()`;
- data: `get_vendor_payment_details(uuid)` returns any verified vendor's bank account, phone and WhatsApp to visitors
  who are not signed in (buyers need it to pay, but signing in could be required); `get_shared_ai_conversation(uuid)`
  (by design for shared links).

Full list - `SECURITY DEFINER`, executable by `anon`, and no `auth.uid()` / `auth.role()` / `is_admin()` /
`owns_vendor()` / `is_vendor_owner()` in the body (re-check on a local baseline database with
`select oid::regprocedure from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and prorettype <> 'trigger'::regtype and has_function_privilege('anon', oid, 'execute') and prosrc !~ 'auth\.uid\(\)|is_admin\(|auth\.role\(\)|owns_vendor|is_vendor_owner'`):
`admin_get_pending_appeals`,
`auto_complete_eligible_orders`, `buyer_can_message_vendor`, `campus_school_names`, `complete_manual_password_reset`,
`compute_monthly_billing_amount`, `compute_product_delivery_fee`, `create_notification`, `ensure_default_category`,
`escalate_unresolved_payment_orders`, `get_comment_authors`, `get_favorite_count(s)`, `get_manual_password_reset_status`,
`get_package_comment_counts`, `get_package_favorite_counts`, `get_past_week_winners`, `get_product_comment_counts`,
`get_product_reviews`, `get_service_price_hint`, `get_shared_ai_conversation`, `get_vendor_follower_counts`,
`get_vendor_payment_details`, `get_vendor_spotlight`, `get_vendor_stats`, `increment_chat_usage`,
`increment_product_view`, `increment_tts_usage`, `increment_vendor_profile_view`, `is_blocked_between`, `notify_admins`,
`notify_comment_mentions`, `notify_rank_upsert`, `process_commission_deadline_reminders`,
`process_listing_billing_reminders`, `process_payment_unresolved_escalations`, `record_social_click`,
`request_manual_password_reset`, `rls_auto_enable`, `send_background_reminders`, `validate_referral_code`.

**S4 - checks that a signed-out caller passes.** Several chat and call functions compare the row's owner with
`auth.uid()` using `<>` / `not in`. For a caller who is not signed in `auth.uid()` is null, the comparison is null
rather than true, and the check lets them through. All are granted to `anon`:

- `edit_message(id, text)` / `delete_message(id)`: rewrite or delete any message sent in the last 30 minutes (e.g. a
  shop's quoted price);
- `update_voice_call(id, 'ended')`: end anyone's call; `ring_callee_again(id)`: ring the callee's phone again;
- `toggle_conversation_pin(id)`: flip the shop's pin of any conversation;
- `raise_dispute(id, reason, attachments)`: open a dispute on any order (its status becomes "disputed", which
  stops the normal flow until an admin resolves it).

They need the message, call or conversation id, which each participant has (so a buyer could sign out and rewrite the
shop's last message). The backend's ports require a signed-in caller who is the sender / a participant. The live fix is
one line per function (`if auth.uid() is null then raise ...`) plus revoking `execute` from `anon`; it needs approval.

**S5 - the messages table can be rewritten directly.** The policy `messages_update_read_status` (meant for read and
delivery times) allows any participant to update **any column** of any message in their conversation (`USING` checks
only that they are in the chat, `WITH CHECK (true)`), and `authenticated` has `UPDATE` on every column. The table's
comment says edits are "limited by trigger", but no such trigger exists. So with the public key and their own sign-in, a
buyer can change the shop's earlier message (a quoted price, a promise), its time, its attachment or its "deleted" flag,
long after the 30-minute edit window `edit_message()` enforces - which undermines chats as evidence in disputes. Proven
on the real schema in `tests/parity/tables-chat.parity.test.ts`. The backend's endpoint only ever sets `read_at` and
`delivered_at`. The live fix: `revoke update on public.messages from anon, authenticated; grant update (read_at,
delivered_at) on public.messages to authenticated;` (edits keep working through `edit_message()`, which runs as its
owner) - it needs approval.

**S6 - engagement settings of someone else's listing.** `product_engagement_settings` and
`package_engagement_settings` let a row be written when `is_vendor_owner(vendor_id)` - the shop named **in the row**,
not the listing's shop. So a vendor can create the settings row for a competitor's listing (one that has none yet: most
listings) with their own shop id and `allow_comments = false` or `like_visibility = 'no_one'`; the real owner's later save
is then refused, because the row now "belongs" to the other shop. Proven in `tests/parity/tables-comments.parity.test.ts`.
The backend checks that the listing belongs to the shop. Live fix: add `and exists (select 1 from products p where
p.id = product_id and p.vendor_id = vendor_id)` (and the package equivalent) to the insert/update policies - approval.

**S7 - comment author names.** `product_comments` copies the author's name and photo from their profile in a trigger
(`snapshot_product_comment_author`), but `package_comments` has no such trigger: the name and photo are whatever the
browser sends, and the shop's notification repeats it ("Levromart Support commented on your package"). On both tables the
update policy lets an author change any column of their comment later, including the name (the trigger only runs on
insert). The backend's endpoints take the name and photo from the profile and offer no update. Live fix: the same
snapshot trigger on `package_comments` (insert and update) - approval.

**S8 - reviews for the wrong shop.** The insert policies on `reviews` check that the order is the buyer's, completed
and paid, but not that `vendor_id` is the order's shop; nothing else sets it. So one cheap completed order lets a buyer
post a review - and move the rating and points - of **any** shop. (One review per order still applies.) Proven in
`tests/parity/tables-reviews-admin.parity.test.ts`. The backend takes the shop from the order. Live fix: add
`and o.vendor_id = reviews.vendor_id` to both insert policies (or set it in `set_review_buyer_snapshot()`) - approval.

**S9 - one's own profile row.** `users_update_self` lets a signed-in user update **every column** of their own row
(`authenticated` has `UPDATE` on all of them); only the role is guarded, by a trigger. So a suspended user can set
their own `suspended_at` / `suspended_reason` back to null (suspension is only enforced by the app reading that
column), an admin can set `is_super_admin = true` (which manages admins and password resets), and anyone can change
`email`, `has_password`, `otp_verified_at` or their legal-terms acceptance. Proven in
`tests/parity/tables-users.parity.test.ts`. The backend's `PATCH /api/v1/me/profile` accepts only name, phone, city,
address, photo, Levi consent and school. Live fix: `revoke update on public.users from anon, authenticated; grant
update (name, phone, city, address, avatar_url, ai_data_consent, campus_id, role, role_selected) on public.users to
authenticated;` - approval.

**S10 - orders written directly.** `orders_update_party_or_admin` lets the order's buyer or the shop's owner update
**any column** (`authenticated` has `UPDATE` on all): the total, the delivery fee, `payout_status`,
`payment_escalated_at`, the quantity proposal... Only status changes are partly guarded (unpaid "completed" is
refused). `orders_insert_buyer` lets a buyer insert an order with any shop, price and status, skipping
`create_sale_order()` and its checks. The app never writes orders directly (every change goes through the order
functions), so removing those two policies breaks nothing. Proven in `tests/parity/tables-orders.parity.test.ts`.
The backend reads orders only; every change goes through its ported functions. Live fix: `drop policy
orders_update_party_or_admin on public.orders; drop policy orders_insert_buyer on public.orders;` (and the same check
for `order_items_insert_via_order`) - approval.

**S11 - shops written directly.** `vendors_update_own_or_admin` lets a shop's owner update **every column** of their
shop. The onboarding trigger only checks that bank details are present when the status is `verified` - it does not
check who sets it. So an applicant can set `verification_status = 'verified'` (with any bank details) and become a
verified vendor without an admin, and any owner can set `admin_paused = false`, `commission_paused`, `avg_rating`,
`review_count`, `student_verified`, `commission_pct` or `billing_model`, or restore a deleted shop
(`deleted_at = null`). (`is_active` is guarded only while commission is owed.) `vendors_insert_own` similarly accepts
a new shop row already marked verified. Proven in `tests/parity/tables-shops.parity.test.ts`. The backend's
`PATCH /api/v1/shops/mine` accepts only the profile, contact, hours, location, campus and document fields; the
payout account has its own endpoint; applications go through `submit_vendor_application()`. Live fix: revoke
`insert`/`update` on `public.vendors` from `anon, authenticated` and grant `update` on those columns only (the
functions that change the rest run as their owner) - approval.

**S12 - every shop's private columns are public.** `vendors_select_public` shows a verified, active shop to anyone,
and `select` is granted on every column: bank code and account number, `paystack_subaccount_code`,
`paystack_authorization_code` (the saved card authorization used for monthly billing), `paystack_customer_code`,
`transfer_recipient_code`, `verification_docs` (the ID document paths), commission and billing
settings. The app's storefront asks for `select("*")`, so all of it reaches every visitor's browser. The backend's
shop endpoints return those columns only to the shop's owner and admins (a buyer gets the bank details they need on
the order page). The CAC number stays public: the product page shows it as a trust sign. Live fix: column grants, or a public view without those columns - approval, and the storefront
query must change at the same time.

**S13 - listings written directly.** `products_update_own_vendor_or_admin` / `vendor_packages_update_own_vendor_or_admin`
let a shop's owner change **every column** of their listings, and the insert policies only check the shop. The rule
that a monthly listing goes live only while its fee is paid lives in the browser (`listingActivationValid()`), so the
owner can set `status = 'active'` with `billing_status = 'active'` and any `billing_paid_until`, create a monthly
listing already active, switch it to `commission`, clear `admin_deleted_at` on a listing an admin removed, or set
their own `view_count`. `package_items_insert_own_vendor` checks only the package, so a package can bundle another
shop's products. Proven in `tests/parity/tables-listings.parity.test.ts` and `tables-packages.parity.test.ts`. The
backend's listing endpoints accept the editor's fields only, decide billing themselves (a monthly listing starts
paused; only the payment check or an admin's receipt approval activates it; reactivation needs a paid period) and
accept only the shop's own products in a package. Live fix: column grants on `products` / `vendor_packages` and a
product check on `package_items` - approval.

## Bugs

**B1 - account deletion (fixed).** `delete_my_account()` only deletes the caller's own account
(`auth.uid() = p_user_id`, or an admin). `api/delete-account.js` called it with the service key, which carries no
user, so it always answered "Not authorized to delete this account." and the account stayed. The new backend had
copied the same call. Both now call it as the signed-in user. To confirm on production after deploying: create a
throwaway account in the app and delete it.

**B2 - double charge on card payment (latent).** For a pay-before order, the trigger
`normalize_order_payment_terms` sets `deposit_amount = total_amount` ("100% up front"). `create_payment_intent()` then
charges `total_amount + deposit_amount` and records two pending payments (sale price and deposit). No screen starts a
card payment for an order today (`payOnline()` is no longer wired to a button), so nobody is being charged twice - but
it must be fixed before card checkout comes back. The backend's port (`/api/initiate-payment` now uses it) charges a
sale's total once and adds the deposit only for rentals, where it is a separate refundable deposit; the test `charges a
pay-before order's total exactly once` passes.

**B3 - "Release payout" for admins.** `transition_order_status()` lets only the order's vendor or buyer change it, and a
buyer only to cancel or return a rental. When an admin resolves a dispute as "completed" on an order whose payment is
held (`83-admin-manage-admins.js`, the `/api/order-payout-action` "release" call), the request goes through it and is
refused. The escrow payout flow (held money,
release, refund) predates the current direct bank-transfer model; decide whether to retire it or give admins a
dedicated function.

**B4 - "mark-manual".** Writes `payout_status = 'paid_manual'`, which `orders_payout_status_check` does not allow
(`not_applicable`, `held`, `released`, `refunded`). The app never calls it.

**B5 - referral message at sign-up.** The trigger `trg_zz_apply_signup_referral` already applies the code when the
account is created; the sign-up endpoint then applies it again "as a safety net", gets `already_used`, and the app shows
"Referral applied" only when that second call succeeds - so it never shows. The referral itself is recorded correctly.

**B8 - "Add a new sector" (fixed in the new backend).** `create_vendor_sector()` inserts a sector with a name and a
sort position but no `slug`, which `sectors` requires (`not null`, unique), so it always fails with "null value in column
slug". Vendors adding their own sector from the catalogue page (`69-my-listings-vendor-catalogue-page.js`) get an
error; the shop-application path uses `get_or_create_custom_sector()`, which does set a slug, and works. The backend's
`POST /api/v1/catalogue/sectors` derives the slug the same way (`custom-` + 20 characters of the name's md5). The live
function is unchanged; the fix reaches users at the switch.

**B9 - reporting a service payment again (fixed in the new backend).** `report_service_offer_payment()` updates the
pending payment it created the first time and sets `provider_reference` (to the value it already has). That fires
`trg_mark_order_payment_unresolved_from_claim`, which, for an offer already in `payment_reported`, sets
`service_offers.expires_at` to null - a `not null` column - so the second report always fails with "null value in column
expires_at". The backend's port leaves `provider_reference` out of that update, so the trigger does not fire; the
function makes the same order changes itself.

**B10 - restoring a vendor from the recycle bin (fixed in the new backend).** `admin_restore_vendor()` puts each package
back with `set status = item->>'status'`: text assigned to a `product_status` column without a cast, which PostgreSQL
refuses ("column status is of type product_status but expression is of type text"). Any shop that had at least one
package therefore cannot be restored; the whole restore is undone. Shops without packages restore fine. The backend
casts the value.

**B11 - monthly listing reminders and expiry (fixed in the new backend).** `process_listing_billing_reminders()`, run
daily by `/api/daily-cron`, declares a variable `period_key` with the same name as a column of
`listing_billing_reminders`, and uses both in one statement. PostgreSQL refuses it ("column reference period_key is
ambiguous") the first time that statement runs - which is as soon as any ₦1,000 monthly product or package is 20, 15,
10, 5, 4 or 1 day(s) from expiry or past it. From then on the whole job fails every day (the cron endpoint answers 502):
no renewal reminders are sent and expired monthly listings are never paused. The backend's port has no such clash; it
sends the reminders once each and pauses expired listings. Worth checking production's `/api/daily-cron` logs.

**B6, B7 - new backend error handling (fixed).** The database raises its user-facing messages with SQLSTATE `22023`
(68 places, e.g. "You cannot follow your own shop.") and `42501` (64, e.g. "Only admins can delete inventory
products."); the backend replaced them with generic texts. It now keeps any message raised by a `RAISE` statement and
stays generic for PostgreSQL's own errors. Separately, 500 responses of the original endpoints used the query layer's
message, "Failed query: <SQL> params: <values>", which can contain personal data; they now carry only PostgreSQL's
message, as Supabase's REST API did.

**B12 - the admin dashboard's open disputes (fixed in the new backend).** The dashboard counts disputes with
`.not("status", "in", "(resolved,closed)")`, but `dispute_status` has only `open` and `resolved`; PostgreSQL refuses
the unknown value `closed`, the count comes back empty and the card shows 0 however many disputes are open. The
backend's `GET /api/v1/admin/dashboard/counts` counts `status = 'open'`.

**B13 - support request attachments (fixed in the new backend).** The app creates the request, uploads the photos to
`support-attachments/<user>/<request>/...`, then saves their list with `update({ attachments })` as the user. The
table's only update policy is for admins, so that update matches no row - without an error - and the request keeps
`attachments: []`: admins never see the photos (the files stay in Storage). The backend's
`PUT /api/v1/support-requests/{id}/attachments` saves them for the request's owner (only files in their folder for
that request).

**B14 - publishing the bundled banners (fixed in the new backend).** The admin carousel's "publish bundled banners"
inserts rows with `storage_path: null`; the column is `not null`, so it always fails. The backend stores `''` for a
banner that has no uploaded file.

**B15 - package comments not live (fixed in the new backend).** Four places in the app subscribe to
`package_comments` changes, but the table is not in the `supabase_realtime` publication, so nothing ever arrives and
other people's comments show only after a refresh (product comments work). Migration 0004's trigger covers
`package_comments`, so `/api/v1/live` delivers them; proven in `tests/parity/live.parity.test.ts`. Live fix without
the backend: `alter publication supabase_realtime add table public.package_comments;` (approval).

**S14 - open broadcast channels (fixed in the new backend).** `conv-<id>` (typing, presence) and `voicecall-<id>`
(WebRTC offer/answer/ICE, "end") are public Realtime channels with no access policy (`baseline/04-realtime.sql` has
none), and the sender's `user_id` is whatever the browser writes. Ids are uuids, so it needs the id (a notification,
a shared screen, a log), but then anyone can listen in on typing, read the call's ICE candidates (IP addresses), send
"end" to drop a call or pretend to be the other person. `/api/v1/live` lets only the conversation's buyer and shop
owner into `conversation:<id>` and only the caller and callee into `call:<id>`, re-checks when the user changes, and
stamps every broadcast with the real sender (`from`). Live fix without the backend: private channels with
`realtime.messages` policies (approval and a frontend change).

## Migrations

**M1 - 0005 (fixed).** The first version checked that no function used `public.inventory`, which on the real schema
stopped it: `delete_my_account()` deletes the user's old inventory rows (needed for the foreign key to `auth.users`).
The corrected 0005 points that one statement at `retired.inventory` in the same transaction, and ignores the word
"inventory" inside messages (`admin_delete_inventory_product()`'s "Product not found in inventory."). It had never been
applied anywhere. CI's "merged migrations are unchanged" check needs the pull request label `migration-edit`.
All six migrations now apply in order on the real schema.

**C3.** `inventory` is in the `supabase_realtime` publication and stays there after it moves to `retired`; a later
migration should `alter publication supabase_realtime drop table retired.inventory`.

## Clean-up candidates

**C4 - the variety trigger.** `notify_variant_followers_batch_aware()` (after insert, or update of name / photo / prices
on `product_variants`) returns early only in `save_product_variants()`' batch mode; otherwise it calls
`notify_vendor_followers_event()` as a plain function, which PostgreSQL refuses ("trigger functions can only be called as
triggers"). So any variety insert or price change outside `save_product_variants()` fails. Nothing else in the app
does that today (orders only change `quantity_available`, which does not fire it), and the backend keeps it that way;
the trigger should be fixed when triggers move.

**C1 - overlapping triggers.** On `orders`: `trg_guard_unverified_order_completion` (unpaid "completed" becomes
`payment_unresolved`) and `trg_prevent_unverified_order_completion` (same check, becomes `disputed`) - the first runs
first, so the second never takes effect; and two buyer-phone checks (`trg_orders_require_buyer_phone`,
`trg_require_buyer_phone_for_order`). On `auth.users`: two profile-creation triggers (`on_auth_user_created`,
`trg_levromart_auth_user_profile`).

**C2 - foreign buckets.** `champion-cvs` and `champion-photos` (created 19 Aug 2026) are not used anywhere in this
repository. If they belong to another project, they should not share Levromart's database.

## Rules the database enforces (the backend must keep them when logic moves)

Learned from the real triggers while moving the tests; the old stand-ins did not have them:

- A profile row (`public.users`) is created by the sign-up triggers on `auth.users`, never inserted separately.
- An account's role changes only through vendor verification (`trg_sync_user_role_from_vendor`) or an admin;
  `trg_prevent_self_role_change` refuses anything else, even from the service role.
- A vendor application needs a WhatsApp number; a verified vendor needs bank name, bank code and account number
  (`trg_enforce_vendor_onboarding_requirements`, admins exempt).
- A vendor's referral code is generated on insert and never changes afterwards.
- Placing an order needs the buyer's phone number.
- An order marked "completed" without a paid sale/rental payment becomes `payment_unresolved` instead.
- Commission is owed only on completed orders (`create_commission_payment_intent()`).
- A product without a category is filed under a default one.
