/**
 * The database functions the app calls with sb.rpc() that the backend answers (POST /api/v1/rpc/{name}).
 * Must list exactly the names in medris-backend/src/modules/rpc/rpc.dispatch.ts (a backend test checks it).
 *
 * Reads may be retried on Supabase when the backend is down or slow; a write is retried there only when it
 * certainly never reached the backend, so nothing runs twice.
 */
export const RPC_READS: ReadonlySet<string> = new Set([
  "list_shop_team", "get_my_shop_teams", "get_my_team_invites", "get_team_shop_orders", "get_team_shop_chats", "get_team_chat_messages",
  "admin_campus_submissions", "admin_find_conversation", "admin_get_conversation_participants",
  "admin_get_inventory", "admin_get_manual_password_reset_requests", "admin_get_pending_appeals",
  "admin_list_conversations", "admin_list_locked_vendors", "admin_list_transactions", "admin_list_vendor_payouts",
  "admin_recent_points_adjustments", "admin_recent_points_skips", "admin_search_points_users", "campus_school_names",
  "can_call_in_conversation", "compute_monthly_billing_amount", "conversation_is_open", "get_call_party",
  "get_comment_authors", "get_conversation_other_party", "get_conversation_presence", "get_favorite_counts",
  "get_legal_terms_consent", "get_manual_password_reset_status", "get_my_account_appeal", "get_my_points_activity",
  "get_my_points_summary", "get_points_cashout_status", "convert_points_to_wallet", "get_order_buyer_contact", "get_orders_buyer_names", "get_owned_product_variants",
  "get_package_comment_counts", "get_package_favorite_counts", "get_past_week_winners", "get_platform_suggestions",
  "get_points_leaderboard", "get_product_comment_counts", "get_product_reviews", "get_reviewable_order_for_product",
  "get_service_price_hint", "get_shared_ai_conversation", "get_vendor_commission_breakdown",
  "get_vendor_commission_deadline", "get_vendor_commission_owed", "get_vendor_follow_state",
  "get_vendor_follow_states", "get_vendor_follower_counts", "get_vendor_follower_customers", "get_vendor_follower_network", "get_vendor_followers", "get_vendor_owner_avatars",
  "get_vendor_followers_v2", "get_vendor_product_regions", "get_vendor_spotlight", "get_vendor_stats",
  "get_vendor_suggestions", "get_withdrawal_summary", "admin_list_withdrawals", "get_setup_status", "get_refund_wallet", "admin_list_cancellations", "list_my_chat_lists", "list_my_conversations", "search_ai_conversations",
  "search_product_ids", "search_products_full_v2", "validate_referral_code",
  // the Levromart wallet (migration 0033) and Levromart's commission wallet (migration 0035)
  "get_levro_wallet", "get_levro_wallet_history", "find_wallet_people", "admin_wallets",
  "get_levromart_wallet", "get_levromart_wallet_history", "get_levromart_wallet_entry", "admin_order_refund_info",
]);

export const RPC_WRITES: ReadonlySet<string> = new Set([
  "add_shop_team_member", "remove_shop_team_member", "set_shop_team_role", "respond_team_invite", "team_send_message", "send_order_still_available",
  "accept_legal_terms", "add_order_note", "add_to_cart", "admin_adjust_points",
  "admin_approve_manual_password_reset", "admin_approve_monthly_listing", "admin_award_social_points",
  "admin_cancel_confirmed_overdue_order", "admin_decide_withdrawal", "admin_set_product_suspended", "admin_decide_cancellation", "buyer_cancel_order", "request_order_cancellation", "admin_reopen_dispute", "admin_confirm_reported_payment", "admin_deactivate_monthly_listing",
  "admin_delete_inventory_product", "admin_delete_vendor", "admin_deny_appeal", "admin_force_unlock_vendor",
  "admin_permanently_delete_vendor", "admin_reject_manual_password_reset", "admin_reject_monthly_listing",
  "admin_reject_reported_payment", "admin_reject_vendor", "admin_restore_vendor", "admin_review_campus_school",
  "admin_review_student_verification", "admin_set_user_role", "admin_set_vendor_status",
  "admin_set_vendor_storefront_active", "admin_suspend_user", "admin_unsuspend_user", "apply_referral_code", "set_my_referral_code",
  "buyer_confirm_received", "buyer_report_manual_payment", "buyer_respond_quantity_proposal", "clear_presence",
  "complete_manual_password_reset", "confirm_service_offer_payment", "create_cart_order", "create_chat_list",
  "create_notification", "create_package_order", "create_rental_order", "create_sale_order", "create_service_offer",
  "create_vendor_category", "create_vendor_sector", "delete_chat_list", "delete_message",
  "dispute_service_offer_payment", "edit_message", "edit_pending_order", "enforce_commission_deadlines",
  "get_order_buyer_avatar", "get_shop_presence", "edit_suggestion_reply", "delete_suggestion_reply", "get_conversation_last_status", "get_or_create_conversation", "get_or_create_custom_sector", "increment_product_view",
  "increment_vendor_profile_view", "mark_conversation_opened", "mark_suggestion_read",
  "process_vendor_commission_hour_reminders", "raise_dispute", "record_auth_activity", "record_offline_payment",
  "answer_chat_request", "remind_all_orders", "remind_order_customer", "request_customer_chat", "report_service_offer_payment", "reply_to_suggestion", "request_withdrawal", "cancel_withdrawal_request", "save_refund_account", "withdraw_refunds", "resolve_dispute", "respond_service_offer", "ring_callee_again",
  "save_product_variants", "send_order_reminder", "set_ai_conversation_shared", "set_order_buyer_location",
  "set_vendor_billing_model", "set_vendor_follow_preferences", "start_voice_call", "submit_account_appeal",
  "submit_campus_school", "submit_face_check", "submit_monthly_listing_payment", "submit_suggestion",
  "submit_vendor_application", "sync_current_account_role", "toggle_ai_message_reaction",
  "toggle_conversation_in_list", "toggle_conversation_pin", "toggle_conversation_unread", "toggle_message_reaction",
  "toggle_vendor_follow", "touch_last_seen", "touch_presence", "transition_order_status", "update_voice_call",
  "vendor_confirm_reported_payment", "vendor_confirm_unreported_payment", "vendor_dispute_reported_payment",
  "vendor_dispute_unreported_payment", "vendor_respond_to_dispute", "vendor_set_storefront_active",
  "vendor_suggest_order_quantity",
  "vendor_decide_cancellation", "get_order_cancellation", "get_wallet_pin_status", "set_wallet_pin", "change_wallet_pin", "wallet_fee_quote", "set_wallet_handle", "wallet_send", "wallet_topup", "wallet_withdraw", "wallet_pay_order",
  "admin_decide_wallet_withdrawal", "admin_set_wallet_frozen", "set_levromart_payout_account", "withdraw_levromart_commission",
]);

export const isBackendRpc = (name: string): boolean => RPC_READS.has(name) || RPC_WRITES.has(name);
