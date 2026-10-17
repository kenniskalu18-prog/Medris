# Supabase dependency audit

> The plan for removing these dependencies, phase by phase: [BACKEND_MIGRATION.md](BACKEND_MIGRATION.md).

Snapshot of every place Levromart depends on Supabase, taken on branch
`refactor/medris-independent-backend` (base `6283939`), before and after this
migration pass. Re-run the scan at any time:

```bash
npm run audit:supabase            # summary tables
npm run audit:supabase -- --json  # every call site as file:line
```

The scan is static (regex over the source); it counts call sites, not traffic.

## 1. Where Supabase is used today

Supabase plays six roles. The database itself is ordinary PostgreSQL 17; the
other five are services around it.

| Supabase service | Used by | How |
|---|---|---|
| **PostgreSQL** (71 tables, 311 functions, 69 triggers, 149 RLS policies, 8 pg_cron jobs) | everything | The business rules live in the database: 265 `SECURITY DEFINER` functions, and RLS policies that all decide access with `auth.uid()`. |
| **PostgREST** (auto REST API: `/rest/v1`, `.from()`, `.rpc()`) | the browser (legacy frontend); the old API handlers | The browser queried tables and called functions directly with the user's JWT; RLS decided what it could see. |
| **Auth** (`auth.users`, JWTs, Google OAuth) | browser + backend | Password sign-in, Google sign-in, sessions and refresh in the browser (supabase-js). The backend verified tokens by calling `/auth/v1/user` and created/deleted users through the admin API. `public.users.id` = `auth.users.id`. |
| **Realtime** | browser | 12 channels: Postgres changes on notifications, messages, orders, payments, comments, points; broadcast/presence for calls and chat. |
| **Storage** | browser + backend | 5 private buckets (signed URLs) and legacy public buckets; public images already live on Cloudflare R2. |
| **pg_cron / pg_net / Vault** | database | 8 scheduled jobs; triggers call `/api/notify` over HTTP with a shared secret. |

### 1.1 Browser (legacy frontend) - before → after this pass

| | before | after |
|---|---:|---:|
| table queries (`.from(...)`) | 509 across 48 tables | 456 (53 moved behind `levroData`) |
| RPC calls (`.rpc(...)`) | 237 across 154 functions | 231 (6 moved) |
| Storage calls | 25 across 9 buckets | 25 (unchanged) |
| Realtime channels | 12 | 12 (unchanged) |
| Auth calls | 34 | 34 (unchanged) |

The moved call sites (cart, favourites, follows, notifications, catalogue
reference data: 58 `levroData` calls in total) keep their old query as the
"feature off" fallback inside `medris-frontend/src/bridge/data-gateway.ts`,
reported separately by the scan.

Auth calls: `signInWithPassword` ×9, `getSession` ×8, `onAuthStateChange` ×7,
`signOut` ×5, `signInWithOAuth` (Google) ×1, `resetPasswordForEmail` ×1,
`updateUser` ×1, `refreshSession` ×1, `getUser` ×1.

Realtime channels: `notifications-<user>`, `marketplace-<user>`,
`orders-live-*`, `order-extras-*`, `requests-live-*`, `conv-<id>` (presence),
`voicecall-<id>` (broadcast), `product-comments-*`, `package-comments-*`,
`levro-inline-*-comments-*`, `lb-live-*` (leaderboard), `cc-*`.

Storage buckets used from the browser:

| bucket | operations |
|---|---|
| `avatars` | remove 1 |
| `chat-attachments` | createSignedUrl 1, createSignedUrls 1, upload 2 |
| `dispute-evidence` | upload 1, createSignedUrl 1 |
| `homepage-carousel` | upload 1, getPublicUrl 1, remove 1 |
| `listing-payment-receipts` | createSignedUrl 1, upload 1, remove 1 |
| `product-photos` | remove 1 |
| `support-attachments` | createSignedUrl 1, upload 1, remove 1 |
| `vendor-docs` | upload 6, createSignedUrl 1 |
| `vendor-logos` | remove 1 |

Tables queried from the browser (calls before / after this pass):

| table | before | after | operations (before) |
|---|---:|---:|---|
| `vendors` | 103 | 103 | select 70, update 24, insert 5, delete 4 |
| `products` | 73 | 73 | select 63, delete 4, update 6 |
| `orders` | 41 | 41 | select 41 |
| `vendor_packages` | 26 | 26 | select 22, update 1, delete 3 |
| `users` | 24 | 24 | select 13, update 11 |
| `cart_items` | 24 | 11 | select 8, delete 12, update 3, insert 1 |
| `messages` | 15 | 15 | update 4, select 10, insert 1 |
| `sectors` | 13 | 3 | select 13 |
| `notifications` | 11 | 1 | select 5, update 6 |
| `vendor_follows` | 11 | 4 | select 10, delete 1 |
| `homepage_carousel_slides` | 11 | 11 | select 4, update 4, insert 2, delete 1 |
| `vendor_student_verification` | 9 | 9 | select 6, upsert 2, update 1 |
| `support_requests` | 8 | 8 | select 5, update 2, delete 1 |
| `product_variants` | 8 | 8 | select 7, delete 1 |
| `product_engagement_settings` | 8 | 8 | select 6, upsert 2 |
| `favorites` | 7 | 1 | select 2, insert 5 |
| `categories` | 7 | 3 | select 7 |
| `package_engagement_settings` | 7 | 7 | select 5, upsert 2 |
| `reviews` | 7 | 7 | select 3, insert 4 |
| `product_comment_likes` | 7 | 7 | select 3, insert 4 |
| `package_comment_likes` | 7 | 7 | select 3, insert 4 |
| `conversations` | 6 | 6 | select 6 |
| `monthly_listing_submissions` | 6 | 6 | select 6 |
| `equipment_requests` | 5 | 5 | insert 1, update 1, select 3 |
| `product_comments` | 5 | 5 | select 1, insert 2, delete 2 |
| `package_comments` | 5 | 5 | select 1, insert 2, delete 2 |
| `ai_messages` | 5 | 5 | select 5 |
| `package_favorites` | 4 | 1 | select 2, delete 1, insert 1 |
| `package_items` | 4 | 4 | select 1, delete 1, insert 2 |
| `blocked_users` | 4 | 4 | select 2, delete 1, insert 1 |
| `message_pins` | 4 | 4 | select 2, insert 1, delete 1 |
| `order_items` | 4 | 4 | select 4 |
| `ai_conversations` | 4 | 4 | select 2, delete 2 |
| `auth_activity_logs` | 3 | 3 | select 3 |
| `disputes` | 3 | 3 | select 3 |
| `voice_calls` | 3 | 3 | select 3 |
| `payments` | 2 | 2 | select 2 |
| `suggestions` | 2 | 2 | select 2 |
| `service_offers` | 2 | 2 | select 2 |
| `admin_actions` | 2 | 2 | insert 1, select 1 |
| `commission_charges` | 2 | 2 | select 2 |
| `push_subscriptions` | 1 | 1 | upsert 1 |
| `vendor_profile_view_events` | 1 | 1 | select 1 |
| `request_offers` | 1 | 1 | insert 1 |
| `product_rating_stats` | 1 | 1 | select 1 |
| `order_notes` | 1 | 1 | select 1 |
| `points_rules` | 1 | 1 | select 1 |
| `comment_reports` | 1 | 1 | insert 1 |

Database functions called from the browser (154 distinct): `get_vendor_commission_deadline` ×9, `get_vendor_commission_owed` ×7, `get_or_create_conversation` ×5, `search_product_ids` ×5, `add_to_cart` ×4, `admin_delete_vendor` ×4, `admin_set_vendor_status` ×4, `get_favorite_counts` ×4, `search_products_full_v2` ×4, `transition_order_status` ×4, `admin_review_campus_school` ×3, `get_owned_product_variants` ×3, `get_vendor_follower_counts` ×3, `get_vendor_stats` ×3, `list_my_conversations` ×3, `toggle_conversation_pin` ×3, `update_voice_call` ×3, `admin_award_social_points` ×2, `admin_list_locked_vendors` ×2, `admin_list_vendor_payouts` ×2, `admin_reject_vendor` ×2, `admin_review_student_verification` ×2, `admin_search_points_users` ×2, `admin_set_user_role` ×2, `admin_unsuspend_user` ×2, `apply_referral_code` ×2, `buyer_report_manual_payment` ×2, `clear_presence` ×2, `create_cart_order` ×2, `create_package_order` ×2, `delete_message` ×2, `enforce_commission_deadlines` ×2, `get_call_party` ×2, `get_or_create_custom_sector` ×2, `get_platform_suggestions` ×2, `get_vendor_follow_state` ×2, `get_vendor_followers` ×2, `get_vendor_spotlight` ×2, `get_vendor_suggestions` ×2, `raise_dispute` ×2, `resolve_dispute` ×2, `search_products_full` ×2, `submit_monthly_listing_payment` ×2, `toggle_vendor_follow` ×2, `vendor_confirm_reported_payment` ×2, `vendor_dispute_reported_payment` ×2, `accept_legal_terms`, `add_order_note`, `admin_adjust_points`, `admin_approve_manual_password_reset`, `admin_approve_monthly_listing`, `admin_campus_submissions`, `admin_cancel_confirmed_overdue_order`, `admin_confirm_reported_payment`, `admin_deactivate_monthly_listing`, `admin_delete_inventory_product`, `admin_deny_appeal`, `admin_find_conversation`, `admin_force_unlock_vendor`, `admin_get_conversation_participants`, `admin_get_inventory`, `admin_get_manual_password_reset_requests`, `admin_get_pending_appeals`, `admin_list_conversations`, `admin_list_transactions`, `admin_permanently_delete_vendor`, `admin_recent_points_adjustments`, `admin_recent_points_skips`, `admin_reject_manual_password_reset`, `admin_reject_monthly_listing`, `admin_reject_reported_payment`, `admin_restore_vendor`, `admin_set_vendor_storefront_active`, `admin_suspend_user`, `buyer_confirm_received`, `buyer_respond_quantity_proposal`, `campus_school_names`, `can_call_in_conversation`, `complete_manual_password_reset`, `compute_monthly_billing_amount`, `confirm_service_offer_payment`, `conversation_is_open`, `create_chat_list`, `create_notification`, `create_rental_order`, `create_sale_order`, `create_service_offer`, `create_vendor_category`, `create_vendor_sector`, `delete_chat_list`, `dispute_service_offer_payment`, `edit_message`, `edit_pending_order`, `get_comment_authors`, `get_conversation_other_party`, `get_conversation_presence`, `get_legal_terms_consent`, `get_manual_password_reset_status`, `get_my_account_appeal`, `get_my_points_activity`, `get_my_points_summary`, `get_order_buyer_contact`, `get_orders_buyer_names`, `get_package_comment_counts`, `get_package_favorite_counts`, `get_past_week_winners`, `get_points_leaderboard`, `get_product_comment_counts`, `get_product_reviews`, `get_reviewable_order_for_product`, `get_service_price_hint`, `get_shared_ai_conversation`, `get_vendor_commission_breakdown`, `get_vendor_follow_states`, `get_vendor_follower_network`, `get_vendor_followers_v2`, `get_vendor_product_regions`, `increment_product_view`, `increment_vendor_profile_view`, `list_my_chat_lists`, `mark_conversation_opened`, `mark_suggestion_read`, `process_vendor_commission_hour_reminders`, `record_auth_activity`, `record_offline_payment`, `report_service_offer_payment`, `respond_service_offer`, `ring_callee_again`, `save_product_variants`, `search_ai_conversations`, `send_order_reminder`, `set_ai_conversation_shared`, `set_order_buyer_location`, `set_vendor_billing_model`, `set_vendor_follow_preferences`, `start_voice_call`, `submit_account_appeal`, `submit_campus_school`, `submit_face_check`, `submit_suggestion`, `submit_vendor_application`, `sync_current_account_role`, `toggle_ai_message_reaction`, `toggle_conversation_in_list`, `toggle_conversation_unread`, `toggle_message_reaction`, `touch_last_seen`, `touch_presence`, `validate_referral_code`, `vendor_confirm_unreported_payment`, `vendor_dispute_unreported_payment`, `vendor_respond_to_dispute`, `vendor_set_storefront_active`, `vendor_suggest_order_quantity`.

### 1.2 Backend (medris-backend) - before → after

| | before | after |
|---|---:|---:|
| PostgREST table calls (service role or user token) | 60 across 16 tables, plus ~25 in Levi's tools | **0** |
| PostgREST RPC calls | 7 (+2 in Levi) | **0** - functions are called over SQL (`database/rpc.ts`) |
| Auth: verify a token (`GET /auth/v1/user`) | every authenticated endpoint | **local JWT verification**; `/auth/v1/user` only as a fallback for HS256 tokens when `SUPABASE_JWT_SECRET` is not set, and in the rare profile-repair path |
| Auth admin API (create, list, delete users; set password) | yes | yes, isolated in `integrations/supabase-auth.ts` |
| Storage API (list/remove on account deletion; copy legacy public files to R2) | yes | yes, behind `integrations/storage/` |

### 1.3 Database objects tied to Supabase

- `auth.uid()` / `auth.role()` / `auth.jwt()` - used by all 149 RLS policies and by ~265 functions.
- Roles `anon`, `authenticated`, `service_role` - every grant and policy targets them.
- `auth.users` / `auth.identities` - `public.users.id` references `auth.users(id)`.
- `storage.*` - 32 policies on bucket paths.
- `pg_net` (`net.http_post`) in `notify_email_on_notification`, `ring_callee_again`, `send_background_reminders`; the webhook secret is embedded in their source.
- `pg_cron` - 8 jobs (`supabase/02_cron_jobs.sql`, manual section 7).
- `supabase_realtime` publication - which tables Realtime streams.

No Supabase Edge Function is used by Levromart (`champions-notify` belongs to another project).

## 2. Classification

### Group 1 - move into the Node.js backend (business logic, data access, authorisation)

| Item | Status |
|---|---|
| The 12 original API handlers' data access (accounts, payments, payouts, settlements, ₦999 listings, monthly billing, notify, reminders, admin OTP, link previews, share cards, Levi tools) | **Done**: SQL through the data layer, no PostgREST |
| Token verification for every endpoint | **Done**: local JWT verification (JWKS / HS256), Supabase only as fallback |
| Cart, favourites, follows, notifications, catalogue reference data (browser call sites) | **Done** behind `VITE_BACKEND_FEATURES` (off by default) |
| Remaining browser table queries and RPCs (orders, checkout, vendor dashboard, listings, messaging, admin, points, reviews, comments, disputes, requests…) | Backlog - same recipe, feature by feature (docs/BACKEND.md) |
| Business rules inside `SECURITY DEFINER` functions | Kept in PostgreSQL during this pass. **Superseded on 14 Oct 2026:** they move into backend services area by area, each behind tests run against the original function first ([BACKEND_MIGRATION.md](BACKEND_MIGRATION.md) §4); money flows last. |

### Group 2 - may reasonably stay on Supabase (infrastructure)

| Item | Why it can stay |
|---|---|
| PostgreSQL hosting | Standard PostgreSQL; the backend connects with `DATABASE_URL` and nothing else. |
| Realtime (12 channels) | Vercel functions cannot hold WebSocket connections; replacing it needs a realtime service (Ably, Pusher, Centrifugo, self-hosted Supabase Realtime). Kept and documented. |
| Storage for private files | Works, signed URLs, policies in place; now reached from the backend through an adapter. Moving files is a separate, approved data migration (docs/STORAGE.md). |
| pg_cron / pg_net | Available on most managed PostgreSQL; otherwise replaced by scheduled workers calling the same SQL functions. |

### Group 3 - Supabase-specific, to replace or isolate for portability

| Item | Isolation now | Replacement path |
|---|---|---|
| `auth.uid()` and the API roles | `database/portability/supabase-compat.sql` recreates them on any PostgreSQL; the backend sets `request.jwt.claims` per transaction exactly like PostgREST | none needed - this keeps all 149 policies working anywhere |
| Supabase Auth (sign-in, sessions, Google) | Backend verifies tokens itself; backend sessions + password + Google sign-in built and tested, **off** | docs/AUTH.md phases 2-4 (needs approval) |
| Auth admin API (create/delete users) | `integrations/supabase-auth.ts` only | replaced when the backend becomes the identity store (AUTH.md phase 4) |
| supabase-js in the browser (PostgREST, Auth, Realtime, Storage) | data calls being moved behind `levroData` | remaining call sites (Group 1 backlog), then Auth, Realtime, Storage |
| Storage API | `integrations/storage/` adapters | S3/R2 adapter for private files when approved |
| Webhook secret inside 3 function bodies | documented | move to a secrets table/Vault when those functions are next changed (approval) |
