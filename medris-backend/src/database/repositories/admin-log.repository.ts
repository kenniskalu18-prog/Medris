import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";

/** The admin audit log (admin_actions): who did what to which record. A trigger notifies the other admins. */
export class AdminLog {
  constructor(private readonly db: Executor) {}

  /**
   * Records an action under the admin's current name - or, with `nameOrEmail`, their name, else their
   * email, else "Admin" (what the vendor functions write).
   */
  async record(
    adminId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    targetLabel: string | null,
    options: { nameOrEmail?: boolean } = {},
  ): Promise<void> {
    const name = options.nameOrEmail
      ? sql`(select coalesce(name, email, 'Admin') from public.users where id = ${adminId})`
      : sql`(select name from public.users where id = ${adminId})`;
    await this.db.execute(sql`
      insert into public.admin_actions (admin_id, admin_name, action, target_type, target_id, target_label)
      select ${adminId}, ${name}, ${action}, ${targetType}, ${targetId}::uuid, ${targetLabel}`);
  }

  /** record(), where a failure must not undo the admin's change (the functions' `exception when others then raise warning`). */
  async recordQuietly(...args: Parameters<AdminLog["record"]>): Promise<void> {
    try {
      await this.db.transaction((sp) => new AdminLog(sp).record(...args));
    } catch {
      // ignored, as the original did (it only raised a warning)
    }
  }
}
