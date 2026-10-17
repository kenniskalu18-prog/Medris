import type { DataContext, Identity } from "../../database/context.js";
import { AdminDashboardRepository, type AdminCounts } from "../../database/repositories/admin-dashboard.repository.js";

/** The admin screens' counts and logs. Runs as the user: only admins see the rows (everyone else gets zeros / nothing). */
export class AdminDashboardService {
  constructor(private readonly db: () => DataContext) {}

  counts(me: Identity, since: string): Promise<AdminCounts> {
    return this.db().asUser(me, (tx) => new AdminDashboardRepository(tx).counts(since));
  }

  loginLog(me: Identity, since: string | null): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new AdminDashboardRepository(tx).loginLog(since));
  }

  actionLog(me: Identity): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new AdminDashboardRepository(tx).actionLog());
  }

  /** Records an admin's action (refused, 403, for anyone who is not an admin). */
  async logAction(me: Identity, a: { action: string; targetType: string; targetId: string | null; targetLabel: string | null }): Promise<{ logged: true }> {
    await this.db().asUser(me, (tx) => new AdminDashboardRepository(tx).logAction(me.userId, a));
    return { logged: true };
  }

  disputesQueue(me: Identity): Promise<{ disputes: Record<string, unknown>[]; unresolvedPayments: Record<string, unknown>[]; unpaidConfirmed: Record<string, unknown>[] }> {
    return this.db().asUser(me, (tx) => new AdminDashboardRepository(tx).disputesQueue());
  }
}
