import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/** The profile fields a user may change themselves (FIX S9: never suspension, super admin, password or sign-in fields). */
export interface ProfileChanges {
  name?: string;
  phone?: string | null;
  city?: string | null;
  address?: string | null;
  avatar_url?: string | null;
  ai_data_consent?: boolean;
  campus_id?: string | null;
}

/**
 * public.users, as the app's table queries read and changed it. Run as the user: one's own row (admins
 * read all); the triggers (role guard, shop photo and school sync, profile-updated) still run.
 */
export class ProfilesRepository {
  constructor(private readonly db: Executor) {}

  /** `from("users").select("*").eq("id", me).single()` */
  own(me: string): Promise<Record<string, unknown> | null> {
    return jsonRow(this.db, sql`select * from public.users where id = ${me}`);
  }

  /** `update({ ...changes }).eq("id", me)` - only the fields given. How many changed. */
  async update(me: string, c: ProfileChanges): Promise<number> {
    const sets = [
      c.name !== undefined ? sql`name = ${c.name}` : null,
      c.phone !== undefined ? sql`phone = ${c.phone}` : null,
      c.city !== undefined ? sql`city = ${c.city}` : null,
      c.address !== undefined ? sql`address = ${c.address}` : null,
      c.avatar_url !== undefined ? sql`avatar_url = ${c.avatar_url}` : null,
      c.ai_data_consent !== undefined ? sql`ai_data_consent = ${c.ai_data_consent}` : null,
      c.campus_id !== undefined ? sql`campus_id = ${c.campus_id}` : null,
    ].filter((x) => x !== null);
    if (sets.length === 0) return 0;
    return (await jsonReturning(this.db, sql`update public.users set ${sql.join(sets, sql`, `)} where id = ${me} returning id`)).length;
  }

  /** `update({ role, role_selected: true }).eq("id", me)` - the role guard trigger only lets the role the account really has through. */
  async selectRole(me: string, role: string): Promise<number> {
    return (await jsonReturning(this.db, sql`update public.users set role = ${role}::public.user_role, role_selected = true where id = ${me} returning id`)).length;
  }

  /** The admin dashboard's people counts and active listings (`select("id", { count: "exact", head: true })`). */
  async counts(): Promise<{ total_users: number; buyers: number; vendors: number; active_products: number }> {
    return (await jsonRow(
      this.db,
      sql`select (select count(*)::int from public.users) as total_users,
                 (select count(*)::int from public.users where role = 'buyer') as buyers,
                 (select count(*)::int from public.users where role = 'vendor') as vendors,
                 (select count(*)::int from public.products where status = 'active') as active_products`,
    ))!;
  }

  /** `select("id, name, email, phone, role, city, created_at, suspended_at, suspended_reason").order("created_at", desc)` - the admin People page. */
  people(): Promise<Record<string, unknown>[]> {
    return jsonRows(this.db, sql`select id, name, email, phone, role, city, created_at, suspended_at, suspended_reason from public.users order by created_at desc`);
  }

  /** `select("id, name, email").eq("role", "admin").order("name")` */
  admins(): Promise<{ id: string; name: string; email: string | null }[]> {
    return jsonRows(this.db, sql`select id, name, email from public.users where role = 'admin' order by name`);
  }

  /** `select("id,name,email,phone,role").in("id", ids)` (and `select("name,email,phone").eq("id", id)`). */
  byIds(ids: string[]): Promise<{ id: string; name: string; email: string | null; phone: string | null; role: string }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return jsonRows(this.db, sql`select id, name, email, phone, role from public.users where id = any(${uuidArray(ids)})`);
  }
}
