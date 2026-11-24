import type { AppServices } from "../../container.js";
import type { Identity } from "../../database/context.js";
import type { RateLimitRule } from "../../middleware/rate-limit.js";
import { notReadyIfMissing, unauthenticated } from "../../shared/errors/app-error.js";

/**
 * The app's database functions (`sb.rpc(name, args)`), answered by the backend's ports.
 *
 * Each entry takes the function's own arguments (p_order_id, p_body...) and gives back what the original returned,
 * in the same JSON form Supabase's REST API sent it: a uuid as a string, a boolean, a JSON object, an array of
 * rows, or null for a function that returns nothing. So the app's code, written against sb.rpc(), keeps working
 * unchanged while the rules run here (see BACKEND_MIGRATION.md, "Switching the app over").
 *
 * The parity suite proves each entry: every runOriginal() in tests/parity also runs the same call through this
 * table and the two outcomes - result, error message and every row changed - must be equal
 * (tests/support/rpc-crosscheck.ts).
 *
 * Not here on purpose: functions only the server calls with the service key (increment_chat_usage,
 * increment_tts_usage, apply_referral_internal, delete_my_account, process_commission_deadline_reminders,
 * process_listing_billing_reminders). They stay where they are.
 */

type Args = Record<string, unknown>;
export interface RpcEntry {
  run: (s: AppServices, me: Identity | null, a: Args) => Promise<unknown>;
  /** The rate limit shared with the matching /api/v1 route. */
  limit?: RateLimitRule;
  /**
   * The answer may be kept in memory for `ttlMs` (rpc.controller.ts). `everyone`: it never depends on who asks (counts,
   * school names...). `signedOut`: it may depend on the caller, so only signed-out visitors share it.
   */
  cache?: { ttlMs: number; who: "everyone" | "signedOut" };
}

const PUBLIC_30S = { ttlMs: 30_000, who: "everyone" } as const;
const SIGNED_OUT_30S = { ttlMs: 30_000, who: "signedOut" } as const;

/* ------------------------------------------------------------- arguments */

/** Text arguments: PostgREST turned any JSON scalar into the parameter's type; undefined means "use the default". */
const str = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
/** Required text/uuid (null passes through so the port reports it the way the original did). */
const id = (v: unknown): string => str(v) as string;
const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isNaN(n) ? (v as number) : n;
};
const bool = (v: unknown): boolean => (v === true || v === "true" || v === "t" ? true : v === false || v === "false" || v === "f" ? false : (v as boolean));
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : v === undefined || v === null ? [] : (v as string[]));
const or = <T>(v: unknown, fallback: T): T => (v === undefined ? fallback : (v as T));
const need = (me: Identity | null): Identity => {
  if (!me) throw unauthenticated();
  return me;
};
const delivery = (a: Args) => ({
  method: str(a.p_delivery_method) as string,
  address: str(a.p_delivery_address),
  phone: str(a.p_delivery_phone),
  lat: num(a.p_buyer_lat),
  lng: num(a.p_buyer_lng),
  campusId: str(a.p_delivery_campus_id),
});

/* ---------------------------------------------------------------- results */

const nothing = () => null;
const pick =
  <K extends string>(key: K) =>
  (r: { [P in K]: unknown }) =>
    r[key];
const yes = () => true;
/** A feature whose database migration is not applied yet answers "being set up" instead of a bare failure. */
const setup = <T>(what: string, work: Promise<T>): Promise<T> => work.catch((e) => { throw notReadyIfMissing(e, what); });

/* ------------------------------------------------------------ rate limits */

const per = (name: string, limit: number, windowMs = 60_000): RateLimitRule => ({ name, limit, windowMs });
const L = {
  account: per("account-write", 30),
  adminUsers: per("admin-users-write", 60),
  adminVendors: per("admin-vendors-write", 60),
  assistant: per("assistant-write", 60),
  calls: per("calls", 60),
  campus: per("campus-write", 20),
  cart: per("cart-write", 120),
  catalogue: per("catalogue-write", 20),
  checkout: per("checkout", 20),
  commission: per("commission-write", 30),
  conversations: per("conversations-write", 120),
  follows: per("follows-write", 60),
  notifySelf: per("notify-self", 20),
  orders: per("order-actions-write", 60),
  passwordReset: per("password-reset", 10, 15 * 60_000),
  paymentClaims: per("payment-claims-write", 30),
  points: per("points-write", 30),
  presence: per("presence", 120),
  products: per("products-write", 30),
  serviceOffers: per("service-offers-write", 30),
  shops: per("shops-write", 20),
  suggestions: per("suggestions-write", 20),
  withdrawals: per("withdrawals-write", 20),
  refundAccount: per("refund-account-write", 20, 3_600_000),
  wallet: per("wallet-write", 20),
  walletPin: per("wallet-pin", 10, 15 * 60_000),
  walletSearch: per("wallet-search", 60),
  platformWallet: per("platform-wallet-write", 12),
};

/* ------------------------------------------------------------------ table */

export const RPC: Record<string, RpcEntry> = {
  // Account
  accept_legal_terms: { run: (s, me) => s.account.acceptLegalTerms(me), limit: L.account },
  get_legal_terms_consent: { run: (s, me) => s.account.legalTermsConsent(me) },
  sync_current_account_role: { run: (s, me) => s.account.syncRole(me).then(pick("role")), limit: L.account },
  get_my_account_appeal: { run: (s, me) => s.account.myAppeal(me) },
  submit_account_appeal: { run: (s, me, a) => s.account.submitAppeal(me, str(a.p_message)).then(nothing), limit: L.account },
  record_auth_activity: { run: (s, me, a) => s.account.recordAuthActivity(me, id(a.p_event_type), str(a.p_user_agent)).then(nothing), limit: L.account },
  get_manual_password_reset_status: { run: (s, _me, a) => s.account.resetStatus(id(a.p_request_id), str(a.p_token)), limit: L.passwordReset },
  complete_manual_password_reset: {
    run: (s, _me, a) => s.account.completeReset(id(a.p_request_id), str(a.p_token), str(a.p_new_password)).then(yes),
    limit: L.passwordReset,
  },

  // Admin: accounts
  admin_get_pending_appeals: { run: (s, me) => s.adminUsers.pendingAppeals(me) },
  admin_deny_appeal: { run: (s, me, a) => s.adminUsers.denyAppeal(me, id(a.p_appeal_id), str(a.p_response)).then(nothing), limit: L.adminUsers },
  admin_suspend_user: { run: (s, me, a) => s.adminUsers.suspend(me, id(a.p_user_id), str(a.p_reason)).then(nothing), limit: L.adminUsers },
  admin_unsuspend_user: { run: (s, me, a) => s.adminUsers.unsuspend(me, id(a.p_user_id)).then(nothing), limit: L.adminUsers },
  admin_set_user_role: { run: (s, me, a) => s.adminUsers.setRole(me, id(a.target_email), id(a.new_role)).then(nothing), limit: L.adminUsers },
  admin_get_manual_password_reset_requests: { run: (s, me) => s.adminUsers.resetRequests(me) },
  admin_approve_manual_password_reset: { run: (s, me, a) => s.adminUsers.approveReset(me, id(a.p_request_id)).then(yes), limit: L.adminUsers },
  admin_reject_manual_password_reset: { run: (s, me, a) => s.adminUsers.rejectReset(me, id(a.p_request_id)).then(yes), limit: L.adminUsers },

  // Admin: vendors
  admin_set_vendor_status: { run: (s, me, a) => s.adminVendors.setStatus(me, id(a.p_vendor_id), id(a.p_status)), limit: L.adminVendors },
  admin_reject_vendor: { run: (s, me, a) => s.adminVendors.reject(me, id(a.p_vendor_id), str(a.p_reason)), limit: L.adminVendors },
  admin_set_vendor_storefront_active: { run: (s, me, a) => s.adminVendors.setStorefront(me, id(a.p_vendor_id), bool(a.p_active)), limit: L.adminVendors },
  admin_force_unlock_vendor: { run: (s, me, a) => s.adminVendors.forceUnlock(me, id(a.p_vendor_id)), limit: L.adminVendors },
  admin_delete_vendor: { run: (s, me, a) => s.adminVendors.delete(me, id(a.p_vendor_id)), limit: L.adminVendors },
  admin_restore_vendor: { run: (s, me, a) => s.adminVendors.restore(me, id(a.p_vendor_id)), limit: L.adminVendors },
  admin_permanently_delete_vendor: { run: (s, me, a) => s.adminVendors.deletePermanently(me, id(a.p_vendor_id)), limit: L.adminVendors },
  admin_list_locked_vendors: { run: (s, me) => s.adminVendors.locked(me) },
  admin_list_transactions: { run: (s, me) => s.adminVendors.transactions(me) },
  admin_list_vendor_payouts: { run: (s, me) => s.adminVendors.payouts(me) },
  admin_review_student_verification: {
    run: (s, me, a) => s.adminVendors.reviewStudent(me, id(a.p_vendor_id), id(a.p_status), str(a.p_note)),
    limit: L.adminVendors,
  },

  // Assistant (Levi's saved conversations)
  search_ai_conversations: { run: (s, me, a) => s.assistant.search(me, id(a.p_query)) },
  get_shared_ai_conversation: { run: (s, _me, a) => s.assistant.shared(id(a.p_token)) },
  set_ai_conversation_shared: {
    run: (s, me, a) => s.assistant.setShared(me, id(a.p_conversation_id), bool(a.p_shared)).then(pick("shareToken")),
    limit: L.assistant,
  },
  toggle_ai_message_reaction: {
    run: (s, me, a) => s.assistant.toggleReaction(me, id(a.p_message_id), str(a.p_emoji)).then(pick("reaction")),
    limit: L.assistant,
  },

  // Calls
  can_call_in_conversation: { run: (s, me, a) => s.calls.canCall(me, id(a.p_conversation_id)).then(pick("callable")) },
  get_call_party: { run: (s, me, a) => s.calls.party(me, id(a.p_conversation_id)) },
  start_voice_call: { run: (s, me, a) => s.calls.start(me, id(a.p_conversation_id)), limit: L.calls },
  ring_callee_again: { run: (s, me, a) => s.calls.ringAgain(me, id(a.p_call_id)).then(pick("rang")), limit: L.calls },
  update_voice_call: { run: (s, me, a) => s.calls.update(me, id(a.p_call_id), id(a.p_status)).then(nothing), limit: L.calls },

  // Campus
  campus_school_names: { run: (s) => s.campus.schoolNames(), cache: { ttlMs: 300_000, who: "everyone" } },
  submit_campus_school: { run: (s, me, a) => s.campus.submit(me, str(a.p_name)), limit: L.campus },
  admin_campus_submissions: { run: (s, me) => s.campus.pending(me) },
  admin_review_campus_school: {
    run: (s, me, a) => s.campus.review(me, id(a.p_norm), id(a.p_action), str(a.p_target)).then(nothing),
    limit: L.campus,
  },

  // Cart and follows (also behind the data gateway)
  add_to_cart: {
    run: (s, me, a) => s.cart.add(need(me), { productId: id(a.p_product_id), quantity: num(a.p_quantity) as number, variantId: str(a.p_variant_id) }).then(pick("result")),
    limit: L.cart,
  },
  toggle_vendor_follow: {
    run: (s, me, a) => s.follows.setFollowing(need(me), id(a.p_vendor_id), bool(a.p_following)).then(pick("result")),
    limit: L.follows,
  },

  // Catalogue
  search_products_full_v2: { run: (s, me, a) => s.catalogue.search(me, str(a.p_query), or(num(a.p_limit), 20)), cache: SIGNED_OUT_30S },
  search_product_ids: { run: (s, me, a) => s.catalogue.searchIds(me, str(a.p_query)), cache: SIGNED_OUT_30S },
  create_vendor_sector: { run: (s, me, a) => s.catalogue.createSector(me, str(a.p_name)).then(pick("id")), limit: L.catalogue },
  create_vendor_category: {
    run: (s, me, a) =>
      s.catalogue.createCategory(me, { name: str(a.p_name), sectorId: str(a.p_sector_id), parentCategoryId: str(a.p_parent_category_id) }).then(pick("id")),
    limit: L.catalogue,
  },
  get_or_create_custom_sector: { run: (s, me, a) => s.catalogue.customSector(me, str(a.p_name)).then(pick("id")), limit: L.catalogue },
  get_service_price_hint: { run: (s, _me, a) => s.catalogue.servicePriceHint(id(a.p_listing_id)), cache: PUBLIC_30S },

  // Checkout
  create_sale_order: {
    run: (s, me, a) =>
      s.checkout
        .sale(me, {
          vendorId: id(a.p_vendor_id),
          productId: id(a.p_product_id),
          quantity: num(a.p_quantity) as number,
          delivery: delivery(a),
          buyerNote: str(a.p_buyer_note),
          variantId: str(a.p_variant_id),
        })
        .then(pick("id")),
    limit: L.checkout,
  },
  create_rental_order: {
    run: (s, me, a) =>
      s.checkout
        .rental(me, {
          vendorId: id(a.p_vendor_id),
          productId: id(a.p_product_id),
          quantity: num(a.p_quantity) as number,
          startDate: id(a.p_start_date),
          endDate: id(a.p_end_date),
          delivery: delivery(a),
        })
        .then(pick("id")),
    limit: L.checkout,
  },
  create_cart_order: {
    run: (s, me, a) =>
      s.checkout
        .cart(me, { vendorId: id(a.p_vendor_id), items: a.p_items as unknown[], delivery: delivery(a), buyerNote: str(a.p_buyer_note) })
        .then(pick("id")),
    limit: L.checkout,
  },
  create_package_order: {
    run: (s, me, a) => s.checkout.package(me, { packageId: id(a.p_package_id), delivery: delivery(a) }).then(pick("id")),
    limit: L.checkout,
  },

  // Commission and monthly billing
  get_vendor_commission_owed: { run: (s, me, a) => s.commission.owed(me, id(a.p_vendor_id)).then(pick("owed")) },
  get_vendor_commission_deadline: { run: (s, me, a) => s.commission.deadline(me, id(a.p_vendor_id)) },
  get_vendor_commission_breakdown: { run: (s, me, a) => s.commission.breakdown(me, id(a.p_vendor_id)) },
  compute_monthly_billing_amount: { run: (s, _me, a) => s.commission.monthlyBillingAmount(id(a.p_vendor_id)) },
  enforce_commission_deadlines: { run: (s, me, a) => s.commission.enforceDeadlines(me, str(a.p_vendor_id)).then(pick("changed")), limit: L.commission },
  process_vendor_commission_hour_reminders: { run: (s, me, a) => s.commission.hourReminders(me, id(a.p_vendor_id)), limit: L.commission },
  submit_monthly_listing_payment: {
    run: (s, me, a) =>
      s.commission.submitMonthlyPayment(me, id(a.p_kind), id(a.p_listing_id), str(a.p_payer_name), str(a.p_receipt_path)).then(pick("id")),
    limit: L.commission,
  },
  admin_approve_monthly_listing: { run: (s, me, a) => s.commission.approveMonthly(me, id(a.p_submission_id)), limit: L.commission },
  admin_reject_monthly_listing: { run: (s, me, a) => s.commission.rejectMonthly(me, id(a.p_submission_id), str(a.p_note)), limit: L.commission },
  admin_deactivate_monthly_listing: { run: (s, me, a) => s.commission.deactivateMonthly(me, id(a.p_submission_id), str(a.p_note)), limit: L.commission },

  // Conversations
  get_or_create_conversation: { run: (s, me, a) => s.conversations.open(me, id(a.p_vendor_id)).then(pick("id")), limit: L.conversations },
  get_conversation_last_status: { run: (s, me, a) => s.conversations.lastStatus(me, ids(a.p_conversation_ids)) },
  list_my_conversations: { run: (s, me) => s.conversations.list(me) },
  conversation_is_open: { run: (s, me, a) => s.conversations.isOpen(me, id(a.p_conversation_id)).then(pick("open")) },
  mark_conversation_opened: { run: (s, me, a) => s.conversations.markOpened(me, id(a.p_conversation_id)).then(nothing), limit: L.conversations },
  get_conversation_other_party: { run: (s, me, a) => s.conversations.otherParty(me, id(a.p_conversation_id)) },
  toggle_conversation_pin: { run: (s, me, a) => s.conversations.togglePin(me, id(a.p_conversation_id)).then(pick("pinned")), limit: L.conversations },
  toggle_conversation_unread: { run: (s, me, a) => s.conversations.toggleUnread(me, id(a.p_conversation_id)).then(pick("unread")), limit: L.conversations },
  delete_message: { run: (s, me, a) => s.conversations.deleteMessage(me, id(a.p_message_id)).then(nothing), limit: L.conversations },
  edit_message: { run: (s, me, a) => s.conversations.editMessage(me, id(a.p_message_id), str(a.p_new_body)).then(nothing), limit: L.conversations },
  toggle_message_reaction: { run: (s, me, a) => s.conversations.toggleReaction(me, id(a.p_message_id), str(a.p_emoji)), limit: L.conversations },
  create_chat_list: { run: (s, me, a) => s.conversations.createList(me, str(a.p_name)).then(pick("id")), limit: L.conversations },
  delete_chat_list: { run: (s, me, a) => s.conversations.deleteList(me, id(a.p_list_id)).then(nothing), limit: L.conversations },
  list_my_chat_lists: { run: (s, me) => s.conversations.lists(me) },
  toggle_conversation_in_list: {
    run: (s, me, a) => s.conversations.toggleInList(me, id(a.p_list_id), id(a.p_conversation_id)).then(pick("inList")),
    limit: L.conversations,
  },
  admin_find_conversation: { run: (s, me, a) => s.conversations.adminFind(me, id(a.p_buyer_id), id(a.p_vendor_id)).then(pick("id")) },
  admin_get_conversation_participants: { run: (s, me, a) => s.conversations.adminParticipants(me, id(a.p_conversation_id)) },
  admin_list_conversations: { run: (s, me, a) => s.conversations.adminList(me, str(a.p_search), or(num(a.p_limit), 100)) },

  // Engagement
  get_favorite_counts: { run: (s, _me, a) => s.engagement.favoriteCounts(ids(a.p_product_ids)), cache: PUBLIC_30S },
  get_package_favorite_counts: { run: (s, _me, a) => s.engagement.packageFavoriteCounts(ids(a.p_package_ids)), cache: PUBLIC_30S },
  get_product_comment_counts: { run: (s, _me, a) => s.engagement.productCommentCounts(ids(a.p_product_ids)), cache: PUBLIC_30S },
  get_package_comment_counts: { run: (s, _me, a) => s.engagement.packageCommentCounts(ids(a.p_package_ids)), cache: PUBLIC_30S },
  get_comment_authors: { run: (s, _me, a) => s.engagement.commentAuthors(ids(a.p_user_ids)), cache: PUBLIC_30S },
  get_vendor_stats: { run: (s, _me, a) => s.engagement.vendorStats(id(a.p_vendor_id)), cache: PUBLIC_30S },
  increment_product_view: { run: (s, _me, a) => s.engagement.countProductView(id(a.p_product_id)).then(nothing) },
  increment_vendor_profile_view: { run: (s, _me, a) => s.engagement.countProfileView(id(a.p_vendor_id)).then(nothing) },
  get_product_reviews: { run: (s, _me, a) => s.engagement.productReviews(id(a.p_product_id)), cache: PUBLIC_30S },
  get_reviewable_order_for_product: { run: (s, me, a) => s.engagement.reviewableOrder(me, id(a.p_product_id)) },

  // Follows
  get_vendor_follow_state: { run: (s, me, a) => s.follows.followState(me, id(a.p_vendor_id)) },
  get_vendor_follow_states: { run: (s, me, a) => s.follows.followStates(me, ids(a.p_vendor_ids)) },
  get_vendor_follower_counts: { run: (s, _me, a) => s.follows.followerCounts(ids(a.p_vendor_ids)), cache: PUBLIC_30S },
  get_vendor_owner_avatars: { run: (s, _me, a) => s.follows.ownerAvatars(ids(a.p_vendor_ids)), cache: PUBLIC_30S },
  get_vendor_followers: { run: (s, me, a) => s.follows.followers(me, id(a.p_vendor_id)) },
  get_vendor_followers_v2: { run: (s, me, a) => s.follows.followersDetailed(me, id(a.p_vendor_id)) },
  get_vendor_follower_customers: { run: (s, me, a) => s.follows.followerCustomers(me, id(a.p_vendor_id)) },
  get_vendor_follower_network: { run: (s, me, a) => s.follows.followerNetwork(me, id(a.p_vendor_id)) },
  set_vendor_follow_preferences: {
    run: (s, me, a) =>
      s.follows.setPreferences(me, id(a.p_vendor_id), {
        muteMode: or(str(a.p_mute_mode), "none"),
        notifyNewListing: bool(or(a.p_notify_new_listing, true)),
        notifyNewService: bool(or(a.p_notify_new_service, true)),
        notifyNewPackage: bool(or(a.p_notify_new_package, true)),
        notifyNewVariety: bool(or(a.p_notify_new_variety, true)),
        notifyPriceChange: bool(or(a.p_notify_price_change, true)),
        notifyDiscount: bool(or(a.p_notify_discount, true)),
      }),
    limit: L.follows,
  },

  // Notifications. FIX (S2): the recipient is always the caller - the app only ever notified itself.
  create_notification: {
    run: (s, me, a) =>
      s.notifications
        .notifySelf(need(me), {
          type: id(a.p_type),
          title: id(a.p_title),
          body: str(a.p_body),
          targetView: str(a.p_target_view),
          targetParams: (a.p_target_params ?? null) as Record<string, unknown> | null,
        })
        .then(nothing),
    limit: L.notifySelf,
  },

  // Order actions
  transition_order_status: { run: (s, me, a) => s.orderActions.transition(me, id(a.p_order_id), id(a.p_new_status)).then(nothing), limit: L.orders },
  buyer_confirm_received: { run: (s, me, a) => s.orderActions.confirmReceived(me, id(a.p_order_id)), limit: L.orders },
  add_order_note: { run: (s, me, a) => s.orderActions.addNote(me, id(a.p_order_id), str(a.p_body)).then(pick("id")), limit: L.orders },
  edit_pending_order: {
    run: (s, me, a) =>
      s.orderActions.editPending(me, id(a.p_order_id), a.p_items, str(a.p_buyer_note), str(a.p_delivery_address), str(a.p_delivery_phone)).then(nothing),
    limit: L.orders,
  },
  get_order_buyer_contact: { run: (s, me, a) => s.orderActions.buyerContact(me, id(a.p_order_id)) },
  get_order_buyer_avatar: { run: (s, me, a) => s.orderActions.buyerAvatar(me, id(a.p_order_id)) },
  get_orders_buyer_names: { run: (s, me, a) => s.orderActions.buyerNames(me, ids(a.p_order_ids)) },
  remind_all_orders: { run: (s, me) => s.orderActions.remindAll(me), limit: L.orders },
  remind_order_customer: { run: (s, me, a) => s.orderActions.remindCustomer(me, id(a.p_order_id)).then(pick("id")), limit: L.orders },
  send_order_still_available: { run: (s, me, a) => s.orderActions.sendStillAvailable(me, id(a.p_order_id)).then(pick("id")), limit: L.orders },
  get_team_shop_chats: { run: (s, me, a) => s.orderActions.teamChats(me, id(a.p_vendor_id)) },
  get_team_chat_messages: { run: (s, me, a) => s.orderActions.teamMessages(me, id(a.p_conversation_id)) },
  team_send_message: { run: (s, me, a) => s.orderActions.teamSend(me, id(a.p_conversation_id), str(a.p_body)), limit: L.conversations },
  get_my_team_invites: { run: (s, me) => s.orderActions.myInvites(me) },
  respond_team_invite: { run: (s, me, a) => s.orderActions.respondInvite(me, id(a.p_vendor_id), a.p_accept === true), limit: L.orders },
  list_shop_team: { run: (s, me) => s.orderActions.teamList(me) },
  add_shop_team_member: { run: (s, me, a) => s.orderActions.teamAdd(me, str(a.p_identifier), str(a.p_role)), limit: L.orders },
  remove_shop_team_member: { run: (s, me, a) => s.orderActions.teamRemove(me, id(a.p_user_id)), limit: L.orders },
  set_shop_team_role: { run: (s, me, a) => s.orderActions.teamSetRole(me, id(a.p_user_id), String(a.p_role ?? "")), limit: L.orders },
  get_my_shop_teams: { run: (s, me) => s.orderActions.myTeams(me) },
  get_team_shop_orders: { run: (s, me, a) => s.orderActions.teamOrders(me, id(a.p_vendor_id), a.p_active_only !== false) },
  request_customer_chat: { run: (s, me, a) => s.orderActions.requestCustomerChat(me, id(a.p_order_id)).then(pick("id")), limit: L.orders },
  answer_chat_request: { run: (s, me, a) => s.orderActions.answerChatRequest(me, id(a.p_vendor_id), a.p_accept === true || a.p_accept === "true"), limit: L.orders },
  send_order_reminder: { run: (s, me, a) => s.orderActions.remind(me, id(a.p_order_id)).then(pick("id")), limit: L.orders },
  set_order_buyer_location: { run: (s, me, a) => s.orderActions.setLocation(me, id(a.p_order_id), num(a.p_lat), num(a.p_lng)).then(nothing), limit: L.orders },
  vendor_suggest_order_quantity: { run: (s, me, a) => s.orderActions.suggestQuantity(me, id(a.p_order_id), a.p_items, str(a.p_note)), limit: L.orders },
  buyer_respond_quantity_proposal: { run: (s, me, a) => s.orderActions.respondToProposal(me, id(a.p_order_id), bool(a.p_accept)), limit: L.orders },

  // Payment claims and disputes
  buyer_report_manual_payment: { run: (s, me, a) => s.paymentClaims.report(me, id(a.p_order_id), num(a.p_amount)), limit: L.paymentClaims },
  vendor_confirm_reported_payment: { run: (s, me, a) => s.paymentClaims.vendorConfirm(me, id(a.p_order_id)), limit: L.paymentClaims },
  vendor_dispute_reported_payment: { run: (s, me, a) => s.paymentClaims.vendorDispute(me, id(a.p_order_id), str(a.p_reason)), limit: L.paymentClaims },
  vendor_confirm_unreported_payment: { run: (s, me, a) => s.paymentClaims.vendorConfirmUnreported(me, id(a.p_order_id)), limit: L.paymentClaims },
  vendor_dispute_unreported_payment: { run: (s, me, a) => s.paymentClaims.vendorDisputeUnreported(me, id(a.p_order_id), str(a.p_reason)), limit: L.paymentClaims },
  admin_confirm_reported_payment: { run: (s, me, a) => s.paymentClaims.adminConfirm(me, id(a.p_order_id), str(a.p_admin_notes)), limit: L.paymentClaims },
  admin_reject_reported_payment: { run: (s, me, a) => s.paymentClaims.adminReject(me, id(a.p_order_id), str(a.p_admin_notes)), limit: L.paymentClaims },
  record_offline_payment: {
    run: (s, me, a) => s.paymentClaims.recordOffline(me, id(a.p_order_id), id(a.p_payment_type), num(a.p_amount), id(a.p_method)).then(pick("id")),
    limit: L.paymentClaims,
  },
  raise_dispute: { run: (s, me, a) => s.paymentClaims.raise(me, id(a.p_order_id), str(a.p_reason), a.p_attachments).then(pick("id")), limit: L.paymentClaims },
  resolve_dispute: {
    run: (s, me, a) => s.paymentClaims.resolve(me, id(a.p_dispute_id), str(a.p_admin_notes), str(a.p_new_order_status)).then(nothing),
    limit: L.paymentClaims,
  },
  vendor_respond_to_dispute: { run: (s, me, a) => s.paymentClaims.respond(me, id(a.p_dispute_id), str(a.p_response)).then(nothing), limit: L.paymentClaims },
  admin_cancel_confirmed_overdue_order: { run: (s, me, a) => s.paymentClaims.cancelOverdue(me, id(a.p_order_id)), limit: L.paymentClaims },

  // Points and referrals
  get_points_leaderboard: { run: (s, me, a) => s.points.leaderboard(me, or(str(a.p_period), "week"), or(num(a.p_limit), 100)), cache: SIGNED_OUT_30S },
  get_past_week_winners: { run: (s, _me, a) => s.points.pastWinners(or(num(a.p_limit), 12)), cache: PUBLIC_30S },
  get_vendor_spotlight: { run: (s, me) => s.points.spotlight(me), cache: SIGNED_OUT_30S },
  get_my_points_summary: { run: (s, me) => s.points.summary(me) },
  get_points_cashout_status: { run: (s, me) => s.points.cashoutStatus(me) },
  convert_points_to_wallet: { run: (s, me, a) => s.points.convertPoints(me, num(a.p_points)), limit: L.wallet },
  get_my_points_activity: { run: (s, me, a) => s.points.activity(me, or(num(a.p_limit), 40), str(a.p_before)) },
  validate_referral_code: { run: (s, _me, a) => s.points.validateCode(str(a.p_code)), limit: L.points },
  set_my_referral_code: { run: (s, me, a) => s.points.setMyCode(me, str(a.p_code)), limit: L.points },
  apply_referral_code: { run: (s, me, a) => s.points.applyCode(me, str(a.p_code)), limit: L.points },
  admin_adjust_points: { run: (s, me, a) => s.points.adjust(me, id(a.p_user), num(a.p_points), str(a.p_note)), limit: L.points },
  admin_award_social_points: { run: (s, me, a) => s.points.awardSocial(me, str(a.p_phone), str(a.p_platform)), limit: L.points },
  admin_recent_points_adjustments: { run: (s, me, a) => s.points.recentAdjustments(me, id(a.p_user)) },
  admin_recent_points_skips: { run: (s, me, a) => s.points.recentSkips(me, or(num(a.p_limit), 30)) },
  admin_search_points_users: { run: (s, me, a) => s.points.searchUsers(me, str(a.p_q)) },

  // Presence
  touch_presence: { run: (s, me) => s.presence.touch(me).then(nothing), limit: L.presence },
  clear_presence: { run: (s, me) => s.presence.clear(me).then(nothing), limit: L.presence },
  touch_last_seen: { run: (s, me) => s.presence.touchLastSeen(me).then(nothing), limit: L.presence },
  get_shop_presence: { run: (s, _me, a) => s.presence.shopPresence(id(a.p_vendor_id)) },
  get_conversation_presence: { run: (s, me, a) => s.presence.conversationPresence(me, id(a.p_conversation_id)).then(pick("last_seen_at")) },

  // Products
  get_owned_product_variants: { run: (s, me, a) => s.products.variants(me, id(a.p_product_id)) },
  save_product_variants: { run: (s, me, a) => s.products.saveVariants(me, id(a.p_product_id), a.p_variants), limit: L.products },
  admin_get_inventory: { run: (s, me) => s.products.inventory(me) },
  admin_delete_inventory_product: { run: (s, me, a) => s.products.deleteInventoryProduct(me, id(a.p_product_id)), limit: L.products },
  get_vendor_product_regions: { run: (s, me, a) => s.products.productRegions(me, id(a.p_vendor_id)) },

  // Service offers
  create_service_offer: {
    run: (s, me, a) => s.serviceOffers.create(me, id(a.p_listing_id), str(a.p_description), num(a.p_price)).then(pick("id")),
    limit: L.serviceOffers,
  },
  respond_service_offer: {
    run: (s, me, a) => s.serviceOffers.respond(me, id(a.p_offer_id), str(a.p_action), num(a.p_price), num(a.p_expected_price)),
    limit: L.serviceOffers,
  },
  report_service_offer_payment: { run: (s, me, a) => s.serviceOffers.reportPayment(me, id(a.p_order_id), num(a.p_amount)), limit: L.serviceOffers },
  confirm_service_offer_payment: { run: (s, me, a) => s.serviceOffers.confirmPayment(me, id(a.p_offer_id)), limit: L.serviceOffers },
  dispute_service_offer_payment: { run: (s, me, a) => s.serviceOffers.disputePayment(me, id(a.p_offer_id)), limit: L.serviceOffers },

  // Shops
  submit_vendor_application: {
    run: (s, me, a) =>
      s.shops
        .apply(me, {
          sectorId: str(a.p_sector_id),
          businessName: str(a.p_business_name),
          address: str(a.p_address),
          city: str(a.p_city),
          phone: str(a.p_phone),
          whatsapp: str(a.p_whatsapp),
          cacNumber: str(a.p_cac_number),
          bio: str(a.p_bio),
          bankCode: str(a.p_bank_code),
          bankName: str(a.p_bank_name),
          accountName: str(a.p_account_name),
          accountNumber: str(a.p_account_number),
        })
        .then(pick("id")),
    limit: L.shops,
  },
  vendor_set_storefront_active: { run: (s, me, a) => s.shops.setStorefront(me, bool(a.p_active)), limit: L.shops },
  set_vendor_billing_model: { run: (s, me, a) => s.shops.setBillingModel(me, id(a.p_billing_model)).then(nothing), limit: L.shops },
  submit_face_check: {
    run: (s, me, a) =>
      s.shops
        .submitFaceCheck(me, {
          selfieUrl: str(a.p_selfie_url),
          distance: num(a.p_distance),
          match: str(a.p_match),
          liveness: a.p_liveness === undefined || a.p_liveness === null ? null : bool(a.p_liveness),
          ocrMatric: a.p_ocr_matric === undefined || a.p_ocr_matric === null ? null : bool(a.p_ocr_matric),
          ocrName: a.p_ocr_name === undefined || a.p_ocr_name === null ? null : bool(a.p_ocr_name),
          ocrText: str(a.p_ocr_text),
        })
        .then(nothing),
    limit: L.shops,
  },

  // Suggestions
  submit_suggestion: {
    run: (s, me, a) =>
      s.suggestions
        .submit(me, {
          targetType: id(a.p_target_type),
          targetVendorId: str(a.p_target_vendor_id),
          message: str(a.p_message),
          isAnonymous: a.p_is_anonymous === undefined || a.p_is_anonymous === null ? null : bool(a.p_is_anonymous),
        })
        .then(pick("id")),
    limit: L.suggestions,
  },
  get_vendor_suggestions: { run: (s, me) => s.suggestions.vendorSuggestions(me) },
  get_platform_suggestions: { run: (s, me) => s.suggestions.platformSuggestions(me) },
  edit_suggestion_reply: { run: (s, me, a) => s.suggestions.editReply(me, id(a.p_suggestion_id), str(a.p_message)), limit: L.suggestions },
  delete_suggestion_reply: { run: (s, me, a) => s.suggestions.deleteReply(me, id(a.p_suggestion_id)), limit: L.suggestions },
  reply_to_suggestion: { run: (s, me, a) => s.suggestions.reply(me, id(a.p_suggestion_id), str(a.p_message)), limit: L.suggestions },
  // Cancelling paid orders
  buyer_cancel_order: { run: (s, me, a) => setup("Cancelling orders", s.cancellations.buyerCancel(me, id(a.p_order_id), str(a.p_reason))), limit: L.withdrawals },
  vendor_decide_cancellation: { run: (s, me, a) => setup("Refund requests", s.cancellations.vendorDecide(me, id(a.p_request_id), id(a.p_decision), str(a.p_reason))), limit: L.withdrawals },
  get_order_cancellation: { run: (s, me, a) => setup("Refund requests", s.cancellations.forOrder(me, id(a.p_order_id))) },
  request_order_cancellation: { run: (s, me, a) => setup("Cancel requests", s.cancellations.request(me, id(a.p_order_id), str(a.p_reason))), limit: L.withdrawals },
  admin_list_cancellations: { run: (s, me, a) => setup("Cancel requests", s.cancellations.adminList(me, str(a.p_status))) },
  admin_decide_cancellation: { run: (s, me, a) => setup("Cancel requests", s.cancellations.decide(me, id(a.p_request_id), id(a.p_decision), str(a.p_reason))), limit: L.withdrawals },
  // The buyer's refunds wallet
  get_refund_wallet: { run: (s, me) => s.buyerWallet.summary(me) },
  save_refund_account: { run: (s, me, a) => s.buyerWallet.saveAccount(me, { bankCode: id(a.p_bank_code), accountNumber: id(a.p_account_number), confirmedAccountName: id(a.p_confirmed_name), password: str(a.p_password) }), limit: L.refundAccount },
  withdraw_refunds: { run: (s, me) => s.buyerWallet.withdraw(me), limit: L.withdrawals },
  admin_set_product_suspended: { run: (s, me, a) => setup("Suspending products", s.productSuspension.set(me, id(a.p_product_id), bool(a.p_suspended), str(a.p_reason))), limit: L.products },
  get_setup_status: { run: (s, me) => s.setupStatus.status(me) },
  // Withdrawals
  get_withdrawal_summary: { run: (s, me) => setup("Withdrawals", s.withdrawals.summary(me)) },
  request_withdrawal: { run: (s, me, a) => setup("Withdrawals", s.withdrawals.request(me, str(a.p_destination) ?? "bank", str(a.p_pin), Array.isArray(a.p_order_ids) ? (a.p_order_ids as unknown[]).map(String) : null, str(a.p_reason))), limit: L.withdrawals },
  // The Levromart wallet (migration 0033)
  get_levro_wallet: { run: (s, me) => s.wallet.summary(me) },
  get_levro_wallet_history: { run: (s, me, a) => s.wallet.history(me, str(a.p_before)) },
  find_wallet_people: { run: (s, me, a) => s.wallet.find(me, str(a.p_query)), limit: L.walletSearch },
  get_wallet_pin_status: { run: (s, me) => s.walletPin.status(me) },
  set_wallet_pin: { run: (s, me, a) => s.walletPin.set(me, str(a.p_pin), str(a.p_pin_confirm)), limit: L.walletPin },
  change_wallet_pin: { run: (s, me, a) => s.walletPin.change(me, { password: str(a.p_password), pin: str(a.p_pin), confirm: str(a.p_pin_confirm) }), limit: L.walletPin },
  wallet_fee_quote: { run: async (s, _me, a) => s.wallet.quote(num(a.p_amount_kobo)) },
  set_wallet_handle: { run: (s, me, a) => s.wallet.changeHandle(me, str(a.p_handle)), limit: L.wallet },
  wallet_send: { run: (s, me, a) => s.wallet.send(me, { toHandle: str(a.p_to), amountKobo: num(a.p_amount_kobo), note: str(a.p_note), key: str(a.p_key), pin: str(a.p_pin) }), limit: L.wallet },
  wallet_topup: { run: (s, me, a) => s.wallet.topup(me, num(a.p_amount_kobo), s.config.appOrigin, str(a.p_pin)), limit: L.wallet },
  wallet_withdraw: { run: (s, me, a) => s.wallet.withdraw(me, num(a.p_amount_kobo), str(a.p_pin)), limit: L.withdrawals },
  wallet_pay_order: { run: (s, me, a) => s.wallet.payOrder(me, str(a.p_order_id), str(a.p_pin)), limit: L.checkout },
  admin_wallets: { run: (s, me, a) => s.wallet.adminList(me, str(a.p_query)) },
  admin_decide_wallet_withdrawal: { run: (s, me, a) => s.wallet.decideWithdrawal(me, str(a.p_id), str(a.p_decision), str(a.p_reason)), limit: L.withdrawals },
  // Levromart's own wallet: the commission (migration 0035)
  get_levromart_wallet: { run: (s, me) => s.platformWallet.summary(me) },
  get_levromart_wallet_history: { run: (s, me, a) => s.platformWallet.history(me, str(a.p_before)) },
  admin_order_refund_info: { run: (s, me, a) => s.refunds.info(need(me), id(a.p_order_id)) },
  get_levromart_wallet_entry: { run: (s, me, a) => s.platformWallet.entry(me, str(a.p_id)) },
  set_levromart_payout_account: {
    run: (s, me, a) => s.platformWallet.setAccount(me, { bankCode: str(a.p_bank_code), accountNumber: str(a.p_account_number), confirmedName: str(a.p_confirmed_name), password: str(a.p_password) }),
    limit: L.platformWallet,
  },
  withdraw_levromart_commission: { run: (s, me, a) => s.platformWallet.withdraw(me, num(a.p_amount_kobo), str(a.p_password)), limit: L.platformWallet },
  admin_set_wallet_frozen: { run: (s, me, a) => s.wallet.adminFreeze(me, str(a.p_user_id), bool(a.p_frozen), str(a.p_reason)), limit: L.adminUsers },
  cancel_withdrawal_request: { run: (s, me, a) => setup("Withdrawals", s.withdrawals.cancel(me, id(a.p_request_id))), limit: L.withdrawals },
  admin_list_withdrawals: { run: (s, me, a) => setup("Withdrawals", s.withdrawals.adminList(me, str(a.p_status))) },
  admin_decide_withdrawal: { run: (s, me, a) => setup("Withdrawals", s.withdrawals.decide(me, id(a.p_request_id), id(a.p_decision), str(a.p_reason))), limit: L.withdrawals },
  admin_reopen_dispute: { run: (s, me, a) => setup("Reopening disputes", s.withdrawals.reopenDispute(me, id(a.p_dispute_id), str(a.p_note))), limit: L.withdrawals },
  mark_suggestion_read: { run: (s, me, a) => s.suggestions.markRead(me, id(a.p_suggestion_id)).then(nothing), limit: L.suggestions },
};

export const RPC_NAMES = Object.keys(RPC).sort();

/** Runs a mapped function; null when the name is not mapped. */
export function rpcEntry(name: string): RpcEntry | null {
  return Object.hasOwn(RPC, name) ? RPC[name]! : null;
}
