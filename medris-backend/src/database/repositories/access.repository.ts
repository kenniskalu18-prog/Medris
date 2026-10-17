import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow } from "../json.js";

/**
 * Who may do what - the database's access helpers, ported. Every check takes the
 * caller's id explicitly (the originals read auth.uid()).
 *
 *   is_admin()               -> isAdmin(userId)
 *   owns_vendor(id) / is_vendor_owner(id) -> ownsVendor(userId, vendorId)
 *   current_role()           -> role(userId)
 *   resolve_account_role(id) -> resolvedRole(userId)
 *   is_blocked_between(a, b) -> isBlockedBetween(a, b)
 *   is_conversation_participant(id) -> isConversationParticipant(userId, id)
 *   is_vendor_follower(id)   -> followsVendor(userId, vendorId)
 */
export class AccessRepository {
  constructor(private readonly db: Executor) {}

  /** Replaces: public.is_admin() - the user's role is admin. */
  async isAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await jsonRow<{ admin: boolean }>(this.db, sql`select coalesce((select role = 'admin' from public.users where id = ${userId}), false) as admin`);
    return row?.admin ?? false;
  }

  /** An admin with is_super_admin (the only one who manages admins and password resets). */
  async isSuperAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await jsonRow(this.db, sql`select 1 as x from public.users where id = ${userId} and role = 'admin' and coalesce(is_super_admin, false)`);
    return row !== null;
  }

  /** Replaces: public.owns_vendor(uuid), public.is_vendor_owner(uuid) - the shop belongs to the user (deleted or not). */
  async ownsVendor(userId: string | null | undefined, vendorId: string): Promise<boolean> {
    if (!userId) return false;
    const row = await jsonRow(this.db, sql`select 1 as x from public.vendors where id = ${vendorId} and user_id = ${userId}`);
    return row !== null;
  }

  /** A verified, active, not deleted shop of this user (who may add sectors and categories). */
  async hasApprovedShop(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await jsonRow(
      this.db,
      sql`select 1 as x from public.vendors where user_id = ${userId} and verification_status = 'verified' and is_active = true and deleted_at is null limit 1`,
    );
    return row !== null;
  }

  /** The user's live (not deleted) shop is this one. */
  async ownsLiveVendor(userId: string | null | undefined, vendorId: string): Promise<boolean> {
    if (!userId) return false;
    return (await jsonRow(this.db, sql`select 1 as x from public.vendors where id = ${vendorId} and user_id = ${userId} and deleted_at is null`)) !== null;
  }

  async role(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const row = await jsonRow<{ role: string }>(this.db, sql`select role from public.users where id = ${userId}`);
    return row?.role ?? null;
  }

  /** The caller's own live (not deleted) shop id, if any. */
  async liveVendorIdOf(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const row = await jsonRow<{ id: string }>(this.db, sql`select id from public.vendors where user_id = ${userId} and deleted_at is null limit 1`);
    return row?.id ?? null;
  }

  /**
   * Replaces: public.resolve_account_role(uuid) - admin stays admin; a verified, not deleted shop makes a vendor
   * (a paused storefront still counts); everyone else is a buyer. Null when there is no profile.
   */
  async resolvedRole(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const row = await jsonRow<{ role: string | null }>(
      this.db,
      sql`select case
                 when u.role is null then null
                 when u.role = 'admin' then 'admin'
                 when exists(select 1 from public.vendors v where v.user_id = u.id and v.verification_status = 'verified' and v.deleted_at is null) then 'vendor'
                 else 'buyer' end as role
          from public.users u where u.id = ${userId}`,
    );
    return row?.role ?? null;
  }

  /** Replaces: public.is_blocked_between(uuid, uuid) - either of the two has blocked the other. */
  async isBlockedBetween(a: string | null, b: string | null): Promise<boolean> {
    const row = await jsonRow<{ blocked: boolean }>(
      this.db,
      sql`select exists (select 1 from public.blocked_users
                         where (blocker_id = ${a}::uuid and blocked_id = ${b}::uuid) or (blocker_id = ${b}::uuid and blocked_id = ${a}::uuid)) as blocked`,
    );
    return row?.blocked ?? false;
  }

  /** Replaces: public.is_conversation_participant(uuid) - the user is the conversation's buyer or the shop's owner. */
  async isConversationParticipant(userId: string | null | undefined, conversationId: string): Promise<boolean> {
    if (!userId) return false;
    const row = await jsonRow(
      this.db,
      sql`select 1 as x from public.conversations c
          where c.id = ${conversationId}
            and (c.buyer_id = ${userId} or (select v.user_id from public.vendors v where v.id = c.vendor_id) = ${userId})`,
    );
    return row !== null;
  }

  /** Replaces: public.is_vendor_follower(uuid) - the user follows the shop. */
  async followsVendor(userId: string | null | undefined, vendorId: string): Promise<boolean> {
    if (!userId) return false;
    return (await jsonRow(this.db, sql`select 1 as x from public.vendor_follows f where f.vendor_id = ${vendorId} and f.follower_id = ${userId}`)) !== null;
  }
}
