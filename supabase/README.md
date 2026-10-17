# Levromart database (Supabase / PostgreSQL)

> **Start with the handover manual: [`docs/LEVROMART_BACKEND_BUILD_MANUAL.pdf`](../docs/LEVROMART_BACKEND_BUILD_MANUAL.pdf)** (7 Oct 2026).
> The matching frontend guide is [`docs/LEVROMART_FRONTEND_BUILD_MANUAL.pdf`](../docs/LEVROMART_FRONTEND_BUILD_MANUAL.pdf).
> It is the current reference for all 71 tables, business logic, cron jobs, security, Vercel API layer and the
> migration playbook. `01_tables.sql` and `02_cron_jobs.sql` below are older snapshots (64 tables, 4 cron jobs).
>
> **The exact current structure** (every table, function, trigger, grant and policy, exported 14 Oct 2026) is in
> [`medris-backend/src/database/baseline/`](../medris-backend/src/database/baseline/README.md); local, test and CI
> databases are built from it. Refresh it with `export.sh` + `npm run db:baseline:update -w medris-backend`.

> **Changing the database:** new changes are migrations in `medris-backend/src/database/migrations/`, applied with
> `npm run db:migrate -w medris-backend` (process and rules: [`docs/DATABASE.md`](../docs/DATABASE.md#3-changing-the-database-migrations)).
> The numbered files in this folder (`01`-`14`) are history - already applied by hand before that process. Do not
> add new files here and do not re-run these.

Live project: `ovklnoroyxobijgvsyfp`. Standby copy: `rtmnrdzmcnlhqfptgkkn` (kept in step by hand).

| File | Contents |
|---|---|
| `01_tables.sql` | All 64 tables, grouped A–I, with columns, types, defaults, primary keys |
| `02_cron_jobs.sql` | The 4 pg_cron jobs |
| `export.sh` | Read-only export of the live structure (schema, functions, grants, policies, triggers, cron, Storage buckets and policies, Auth triggers, Realtime tables, extensions) into `supabase/export/` (git-ignored; the webhook secret and common key formats are removed automatically) |
| this file | Index of functions, triggers, policies and conventions |

Security model: **Row Level Security is on for every table** (144 policies). Anything that must
bypass RLS is a `SECURITY DEFINER` function that checks `auth.uid()` itself. The browser only holds
the public anon key; payment secrets, the service-role key and the webhook secret live in Vercel
environment variables / inside two database functions (see "Secrets" below).

## Functions by area (233)

Names marked **(definer)** run with elevated rights. Overloads are listed once.

**Orders & checkout** – `create_sale_order` (3 overloads), `create_rental_order`, `create_package_order`,
`create_cart_order`, `create_rental_booking`, `edit_buyer_order`, `edit_pending_order`, `transition_order_status`,
`vendor_decline_order`, `set_order_buyer_note`, `set_order_buyer_location`, `set_order_item_variant`,
`add_order_note`, `send_order_reminder`, `remind_unattended_orders` (cron), `auto_complete_eligible_orders`,
`get_order_buyer_contact` (vendors see the customer's name only after accepting; phone is admin-only),
`get_order_vendor_payment_details`, `compute_delivery_fee`, `compute_product_delivery_fee`.

**Payments & disputes** – `create_payment_intent`, `record_offline_payment`, `buyer_report_manual_payment`,
`vendor_confirm_reported_payment`, `vendor_dispute_reported_payment`, `vendor_confirm_unreported_payment`,
`vendor_dispute_unreported_payment`, `escalate_unresolved_payment_orders` (cron), `process_payment_unresolved_escalations`,
`raise_dispute`, `vendor_respond_to_dispute`, `resolve_dispute`, `admin_confirm_reported_payment`,
`admin_reject_reported_payment`, `admin_list_transactions`, `admin_list_vendor_payouts`.

**Commission & vendor billing** – `create_commission_payment_intent`, `enforce_commission_deadlines`,
`process_commission_deadline_reminders` (cron 07:00; reminders at 5/3/2/1 days + due day),
`process_vendor_commission_hour_reminders`, `get_vendor_commission_owed`, `get_vendor_commission_deadline`,
`get_vendor_commission_breakdown`, `set_vendor_billing_model`, `compute_monthly_billing_amount`,
`submit_monthly_listing_payment`, `admin_approve_monthly_listing`, `admin_reject_monthly_listing`,
`admin_deactivate_monthly_listing`, `process_listing_billing_reminders`, `record_order_completion_commission` (trigger).

**Vendors & admin** – `submit_vendor_application`, `admin_approve_vendor`, `admin_reject_vendor`,
`admin_set_vendor_status`, `admin_delete_vendor`, `admin_trash_vendor`, `admin_restore_vendor`,
`admin_permanently_delete_vendor`, `admin_force_unlock_vendor`, `admin_list_locked_vendors`,
`admin_set_vendor_storefront_active`, `vendor_set_storefront_active`, `admin_set_user_role`,
`admin_suspend_user`, `admin_unsuspend_user`, `admin_get_pending_appeals`, `admin_deny_appeal`,
`submit_account_appeal`, `admin_*_manual_password_reset`, `request_manual_password_reset`,
`complete_manual_password_reset`, `admin_list_conversations`, `admin_find_conversation`,
`admin_get_conversation_participants`, `delete_my_account`, `get_vendor_stats`, `get_vendor_product_regions`,
`get_vendor_payment_details`, `increment_vendor_profile_view`, `nearby_vendors`.

**Catalogue & search** – `search_products_full` (original) and `search_products_full_v2` (adds vendor id,
rating, review count, listing type, service unit — used by the Search page; the app falls back to the original
if v2 is missing), `search_product_ids`, `save_product_variants`, `get_owned_product_variants`,
`increment_product_view`, `get_favorite_count(s)`, `get_product_reviews`, `get_reviewable_order_for_product`,
`create_vendor_category`, `create_vendor_sector`, `get_or_create_custom_sector`, `admin_delete_inventory_product`, `admin_get_inventory`.

**Cart** – `add_to_cart`, trigger `prevent_vendor_self_cart_item`.

**Messaging & calls** – `get_or_create_conversation`, `list_my_conversations` (open chats only; shows the shop
name/logo to buyers), `conversation_is_open` (a chat closes 24 h after its order completes — it is hidden,
never deleted), `mark_conversation_opened`, `toggle_conversation_pin`, `toggle_conversation_unread`,
`edit_message`, `delete_message`, `toggle_message_reaction`, `create_chat_list`, `delete_chat_list`,
`list_my_chat_lists`, `toggle_conversation_in_list`, `get_conversation_other_party`, `get_conversation_presence`,
`touch_last_seen`, `am_i_blocked_with`, `is_blocked_between`, `buyer_can_message_vendor`,
`can_call_in_conversation`, `get_call_party`, `start_voice_call`, `update_voice_call`, `ring_callee_again`
(re-sends the call push; contains the webhook secret), `chat_purge_candidates` (intentionally returns nothing).

**Follows & social** – `toggle_vendor_follow`, `get_vendor_follow_state(s)`, `get_vendor_follower_counts`,
`get_vendor_followers`, `is_vendor_follower`, `set_vendor_follow_preferences`, `submit_suggestion`,
`get_vendor_suggestions`, `get_platform_suggestions`, `mark_suggestion_read`, `get_product_comment_counts`,
`get_package_comment_counts`, `get_package_favorite_counts`.

**Requests, offers & service offers** – `accept_request_offer`, `create_service_offer`, `respond_service_offer`,
`report_service_offer_payment`, `confirm_service_offer_payment`, `dispute_service_offer_payment`,
`get_service_price_hint`, `process_service_offer_deadlines` (cron).

**Notifications** – `create_notification`, `notify_admins`, and the `notify_*` trigger functions (new order, order
status, message, review, offer, request, payment, dispute, signup, vendor application, follows, listing events,
low stock). `notify_email_on_notification` forwards every notification row to `/api/notify` (email + push).

**Levi (AI)** – `increment_chat_usage`, `increment_tts_usage`, `search_ai_conversations`,
`set_ai_conversation_shared`, `get_shared_ai_conversation`, `toggle_ai_message_reaction`.

**Accounts & roles** – `handle_new_user`, `handle_new_levromart_user`, `current_role`, `is_admin`,
`owns_vendor`, `is_vendor_owner`, `resolve_account_role`, `sync_current_account_role`,
`accept_legal_terms`, `get_legal_terms_consent` (terms version string), `record_auth_activity`,
`log_auth_session_start`, `get_my_account_appeal`.

**Housekeeping triggers** – `set_updated_at_timestamp`, `touch_*`, `sync_*`, `prevent_*`, `enforce_*`,
`set_*_snapshot`, `levromart_stamp_order_status`, `normalize_*`, `rls_auto_enable`.

## Triggers (60)

`orders`: stamp status clock, normalize payment terms, require buyer phone, prevent vendor self-order, guard
unverified completion, notify new order / status change, record commission on completion, restore stock when a sale
is cancelled. `payments`: notify paid, mark order "payment unresolved" from a claim. `messages`: notify new message
(sends sender photo / shop identity). `notifications`: email + push forwarder. `vendors`: onboarding requirements,
phone validation, commission-activation guard, role sync, profile-updated, payout setup notice, new application notice.
`users`: prevent self role change, avatar syncs, new signup notice. `products` / `vendor_packages` /
`product_variants`: notify followers, low stock, remove monthly submission when removed. `reviews`: snapshot buyer,
notify, update vendor rating. `favorites`, `product_comments`, `product_comment_likes`, `vendor_follows`,
`request_offers`, `equipment_requests`, `disputes`, `service_offers`, `support_requests`, `ai_messages`,
`listing_drafts`, `homepage_carousel_slides`, `message_pins` (limit), `cart_items` (no self purchase),
`order_items` (deposit percent sync), `admin_actions` (notify admins).

## Row-level security (144 policies)

Every table has RLS. Typical shapes: owner-only (`user_id = auth.uid()`), participant-only
(conversations/messages/voice_calls), vendor-owner (`owns_vendor(vendor_id)`), public read
(`reviews`, `sectors`, `categories`, active catalogue) and admin override (`is_admin()`).
Policy count per table: orders 3, vendors 3, products 4, messages 3, notifications 4, voice_calls 1 (participants read;
writes go through `start_voice_call` / `update_voice_call`), all others 1–5.

## Secrets (not in git)

Two functions embed the webhook secret used to call `/api/notify`:
`notify_email_on_notification` and `ring_callee_again`. When you re-create them in a new project set the same
value as the `EMAIL_WEBHOOK_SECRET` environment variable in Vercel.

## Conventions

* Functions are `snake_case`, parameters start with `p_`.
* Money is `numeric` in naira (not kobo); the Paystack API converts at the edge in `api/`.
* Never delete chats; `conversation_is_open` hides them instead.
* When adding an RPC that the browser calls, make it `SECURITY DEFINER`, `set search_path = public`, check
  `auth.uid()` first, and `grant execute ... to authenticated`.

## Quantity suggestions (added Oct 2026)

`orders.quantity_proposal` (jsonb) holds a vendor's counter-offer. `vendor_suggest_order_quantity(order, items, note)` (vendor, pending
sale orders) stores it and notifies the buyer; `buyer_respond_quantity_proposal(order, accept)` applies or clears it and notifies the vendor.
`create_cart_order` no longer refuses orders above the stock counter (stock is floored at zero), matching `create_sale_order`.

## Leaderboard, points and referrals (added Oct 2026)

Vendors earn points for real activity; the vendor with the most points each Lagos-time week (Mon 00:00 to Sun 24:00) is
Vendor of the Week. Everything is automatic and server-side, nothing is trusted from the browser.

**Tables** (all RLS, writes only through `SECURITY DEFINER` functions): `points_rules` (the point values, editable at any
time: `update points_rules set points = ...`), `points_ledger` (one row per awarded event, `unique(user_id, event_key)` makes
every event count once), `points_weekly` (per user per week totals, in the realtime publication so the board updates live),
`vendor_week_winners` (finalised weeks, `reward_status` pending/void), `referrals` (one row per referred user),
`vendors.referral_code` (unique, issued automatically, never changes).

**Point values** (see `points_rules`): completed paid sale 100 (orders under ₦1,000 skipped, same customer max 3 a week, taken back
if the order is later cancelled/disputed), 5-star review 20, 4-star 10, 3-star 5 (order must be ₦1,000+; editing a rating moves the
points), vendor joins with your code 50 (paid on verification), customer joins 20 (max 10/day), vendor-of-vendor 25, customer-of-vendor 10,
referred vendor lists a product 2 (first 10), new follower 5 (max 25/day), social link tap 5 (once per platform, referrer gets 5 too),
list a product 5 (max 5/week), complete shop profile 20 (once).

**Engine**: `award_points`, `revoke_points`, `notify_points` (internal, no execute grants). Triggers: `trg_points_follow`,
`trg_points_review`, `trg_points_order`, `trg_points_listing` (products + vendor_packages), `trg_points_vendor`,
`trg_vendor_referral_code`. All trigger bodies swallow their own errors so points can never block an order or a follow.
`notify_points` keeps one unread "+N points" notification per 3 hours (topped up, not spammed); `api/notify.js` does not email it.

**RPCs** (browser): `get_points_leaderboard(period, limit)` (week/last_week/month/all), `get_my_points_summary()`,
`get_my_points_activity(limit, before)`, `get_vendor_spotlight()`, `get_past_week_winners(limit)`, `validate_referral_code(code)`,
`apply_referral_code(code)` (own account, within 7 days, once, not your own code/phone), `record_social_click(platform)`,
`admin_adjust_points(user, points, note)` (admins, positive or negative). `finalize_points_weeks()` crowns winners lazily on any
leaderboard read and by pg_cron job `levromart-finalize-points-week` (Sun 23:05 UTC).

**Voiding things without deleting**: set `vendor_week_winners.reward_status = 'void'` to hide a winner; use `admin_adjust_points`
with a negative value to take points back.

**Update (Oct 2026):** the board shows only This week and Last week (points start from zero every Monday 00:00 Lagos time; lifetime totals
stay on "My points"). Social-follow points are no longer awarded on tap: people follow, screenshot and WhatsApp 08063227669, then an admin
adds them with `admin_award_social_points(phone, platform)` (Earn points tab, admin only; also pays the referrer once per platform).
`record_social_click` is now a no-op kept for older clients.

**Sign-up referrals:** the sign-up form sends `referral_code` to `/api/delete-account` (register). It is stored in the auth user metadata and applied
instantly by `trg_zz_apply_signup_referral` (and once more by the server through `apply_referral_internal`, service role only), so the vendor is credited the
moment the account exists. People applying as vendors skip the customer award; the vendor award is paid when they are verified.
`profile_complete` is now paid only when a profile goes from incomplete to complete, never for vendors who already had a logo, bio, address and city.

**Realtime publication (Oct 2026):** `supabase_realtime` now also carries `order_items`, `order_notes`, `service_offers`, `equipment_requests`, `request_offers`, `disputes`
and `points_weekly`. A client channel that binds a table missing from the publication fails as a whole (`CHANNEL_ERROR`), so every table the app listens to must be in it.
The client uses three independent channels (orders+payments, order extras, requests+disputes), re-subscribes after an error, repaints on reconnect and runs a 6-second
fingerprint poll while an order screen is open as a safety net.

**Listing points (Oct 2026):** a listing earns `product_listed` once (and `ref_vendor_product` for the referrer); pausing/unpausing never pays again (event key).
`trg_points_listing` takes the points back when a listing's status becomes removed or `admin_deleted_at` is set; listings deleted outright are caught by
`points_reconcile_listings()` (called by `finalize_points_weeks()` on every leaderboard read and by pg_cron `levromart-points-reconcile` every 10 minutes).

**Stock tracking default (Oct 2026):** `products.track_quantity` now defaults to `false` and every existing product was switched to untracked (the same shape the app writes
when a vendor turns tracking off: `quantity_total = quantity_available = 999999`, so the order/edit functions that still read `quantity_available` never block a sale).
Vendors turn tracking on per listing in the Stock section and enter a quantity.

**Points fixes and admin tools (Oct 2026):** sales and reviews now need an order of at least ₦500 (`points_rules.min_amount`, previously a hard-coded ₦1,000 that silently skipped ₦589 orders),
and one customer counts up to 5 times a week (`per_source_weekly_cap`). Award logic lives in `points_award_order()` / `points_award_review()`; every skipped event is logged in `points_skips`
with the reason (also daily/weekly limits). This week's missed sales and reviews were backfilled. Admin RPCs: `admin_search_points_users`, `admin_adjust_points` (add or take away, notifies the person),
`admin_recent_points_skips`, `admin_recent_points_adjustments`, `admin_award_social_points`; UI at the Points manager page (admin drawer).

**Delivery by distance (Oct 2026):** `compute_delivery_fee` / `compute_product_delivery_fee` charge at least one kilometre (`rate x greatest(distance, 1)`, rounded to the nearest ₦50), so a distance-priced
delivery is never shown as Free for a buyer standing next to the shop. The client mirrors this in `distanceDeliveryFee()`.
**Dispute evidence:** `disputes.attachments` (jsonb, up to 3 images), private storage bucket `dispute-evidence` (`{user}/{order}/{file}`; readable by the uploader, the two parties on the order and admins) and
`raise_dispute(order, reason, attachments)`; images are shown on the order page and in the admin disputes list through signed links.

**Smarter search (Oct 2026)** – `search_products_full_v2` and `search_product_ids` now rank by name first (name starts with the query, every typed word starting a word in the name, then typo tolerance via word_similarity, synonyms, category, shop name, description last). Partial words ("skin aqu") work. Results keep this relevance order; the app no longer re-sorts search results by price.

**Rank-change alerts (Oct 2026)** – `trg_points_rank_notify` on `points_weekly` notifies a vendor who climbs the weekly board (top 10) and every vendor they pass (type `rank_change`, merged per user for 20 minutes, push + in-app only). Failures never block awarding points.

**Followers page (Oct 2026)** – `get_vendor_followers_v2(vendor)` (owner only) returns followers with vendor/customer flag, connection level (1 you follow them, 2 mutual, 3 third) and "via" name.
