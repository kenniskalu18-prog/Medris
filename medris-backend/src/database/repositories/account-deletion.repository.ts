import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonRow } from "../json.js";

/**
 * Deleting an account's data in an order the foreign keys allow (delete_my_account()). The auth user
 * itself is removed separately (Supabase Auth admin API).
 */
export class AccountDeletionRepository {
  constructor(private readonly db: Executor) {}

  private async ids(query: ReturnType<typeof sql>): Promise<string[]> {
    return (await jsonRow<{ ids: string[] }>(this.db, sql`select coalesce(array_agg(id), '{}') as ids from (${query}) q`))!.ids;
  }

  /** Every public row that belongs to the user, their shops, orders, conversations and listings. */
  async deleteEverything(uid: string): Promise<void> {
    const vendorIds = await this.ids(sql`select id from public.vendors where user_id = ${uid}`);
    const vendors = uuidArray(vendorIds);
    const orderIds = await this.ids(sql`select id from public.orders where buyer_id = ${uid} or vendor_id = any(${vendors})`);
    const conversationIds = await this.ids(sql`select id from public.conversations where buyer_id = ${uid} or vendor_id = any(${vendors})`);
    const aiConversationIds = await this.ids(sql`select id from public.ai_conversations where user_id = ${uid}`);
    const requestIds = await this.ids(sql`select id from public.equipment_requests where buyer_id = ${uid}`);
    const packageIds = await this.ids(sql`select id from public.vendor_packages where vendor_id = any(${vendors})`);
    const reviewIds = await this.ids(sql`select id from public.reviews where buyer_id = ${uid} or vendor_id = any(${vendors})`);
    // The old inventory table is still in public (a clean-up may later move it to schema "retired"); it is cleared wherever it is.
    const inventory = (await jsonRow<{ t: string | null }>(this.db, sql`select coalesce(to_regclass('retired.inventory'), to_regclass('public.inventory'))::text as t`))!.t;
    const run = (statement: ReturnType<typeof sql>) => this.db.execute(statement);

    await run(sql`delete from public.ai_messages where conversation_id = any(${uuidArray(aiConversationIds)})`);
    await run(sql`delete from public.ai_conversations where user_id = ${uid}`);
    await run(sql`delete from public.chat_list_conversations where list_id in (select id from public.chat_lists where user_id = ${uid})`);
    for (const table of ["chat_lists", "chat_usage", "tts_usage", "push_subscriptions", "notifications", "support_requests", "account_appeals", "admin_login_otps"]) {
      await run(sql`delete from ${sql.raw(`public.${table}`)} where user_id = ${uid}`);
    }
    await run(sql`delete from public.admin_actions where admin_id = ${uid}`);
    await run(sql`delete from public.suggestions where sender_id = ${uid}`);
    if (inventory) await run(sql`delete from ${sql.raw(inventory)} where owner_id = ${uid}`);
    await run(sql`delete from public.messages where sender_id = ${uid}`);
    if (conversationIds.length > 0) {
      const conversations = uuidArray(conversationIds);
      await run(sql`delete from public.messages where conversation_id = any(${conversations})`);
      await run(sql`delete from public.conversations where id = any(${conversations})`);
    }
    if (orderIds.length > 0) {
      const orders = uuidArray(orderIds);
      for (const table of ["disputes", "payments", "reviews", "order_items"]) await run(sql`delete from ${sql.raw(`public.${table}`)} where order_id = any(${orders})`);
      await run(sql`delete from public.orders where id = any(${orders})`);
    }
    await run(sql`delete from public.reviews where id = any(${uuidArray(reviewIds)})`);
    await run(sql`delete from public.request_offers where request_id = any(${uuidArray(requestIds)}) or vendor_id = any(${vendors})`);
    await run(sql`delete from public.equipment_requests where buyer_id = ${uid}`);
    await run(sql`delete from public.package_favorites where buyer_id = ${uid}`);
    await run(sql`delete from public.favorites where buyer_id = ${uid}`);
    if (packageIds.length > 0) {
      const packages = uuidArray(packageIds);
      await run(sql`delete from public.package_items where package_id = any(${packages})`);
      await run(sql`delete from public.vendor_packages where id = any(${packages})`);
    }
    for (const table of ["commission_settlements", "commission_charges", "vendor_monthly_charges"]) await run(sql`delete from ${sql.raw(`public.${table}`)} where vendor_id = any(${vendors})`);
    await run(sql`delete from public.cart_items where buyer_id = ${uid}`);
    await run(sql`delete from public.products where vendor_id = any(${vendors})`);
    await run(sql`update public.account_appeals set resolved_by = null where resolved_by = ${uid}`);
    await run(sql`update public.users set suspended_by = null where suspended_by = ${uid}`);
    await run(sql`delete from public.vendors where user_id = ${uid}`);
    await run(sql`delete from public.users where id = ${uid}`);
  }
}
