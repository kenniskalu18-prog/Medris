import type { MeResponse } from "../../contracts/v1.js";
import type { DataContext, Identity } from "../../database/context.js";
import { UsersRepository } from "../../database/repositories/users.repository.js";
import { notFound } from "../../shared/errors/app-error.js";
import { ProfilesRepository, type ProfileChanges } from "../../database/repositories/profiles.repository.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";

/** Account profiles (public.users). */
export class UsersService {
  constructor(private readonly db: () => DataContext) {}

  async me(me: Identity): Promise<MeResponse> {
    const profile = await this.db().asUser(me, (tx) => new UsersRepository(tx).findById(me.userId));
    if (!profile) throw notFound("Account profile not found.");
    return profile;
  }

  /** The caller's role, read as the caller (null when signed out or without a profile). */
  async roleOf(identity: Identity | null): Promise<string | null> {
    if (!identity) return null;
    return this.db().asUser(identity, (tx) => new UsersRepository(tx).roleOf(identity.userId));
  }

  /** The caller's whole profile row, as the app read it (`select("*")`). */
  profile(me: Identity): Promise<Record<string, unknown> | null> {
    return this.db().asUser(me, (tx) => new ProfilesRepository(tx).own(me.userId));
  }

  /**
   * Changes the caller's own profile. Replaces the app's updates of public.users (name, phone, city, address,
   * photo, Levi data consent, school). FIX S9: nothing else - the table let a user change any column of their
   * own row, including clearing their own suspension (and an admin making themselves super admin).
   */
  async updateProfile(me: Identity, changes: ProfileChanges): Promise<{ updated: number }> {
    return { updated: await this.db().asUser(me, (tx) => new ProfilesRepository(tx).update(me.userId, changes)) };
  }

  /** The first-run role screen: the account's real role (vendor with a verified shop, admin, otherwise buyer), marked as chosen. */
  async selectRole(me: Identity): Promise<{ role: string | null }> {
    return this.db().asUser(me, async (tx) => {
      const role = await new AccessRepository(tx).resolvedRole(me.userId);
      if (role) await new ProfilesRepository(tx).selectRole(me.userId, role);
      return { role };
    });
  }

  /** The admin dashboard's counts (0 for anyone but an admin, who sees only themselves). */
  counts(me: Identity): Promise<{ total_users: number; buyers: number; vendors: number; active_products: number }> {
    return this.db().asUser(me, (tx) => new ProfilesRepository(tx).counts());
  }

  people(me: Identity): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new ProfilesRepository(tx).people());
  }

  admins(me: Identity): Promise<{ id: string; name: string; email: string | null }[]> {
    return this.db().asUser(me, (tx) => new ProfilesRepository(tx).admins());
  }

  byIds(me: Identity, ids: string[]): Promise<{ id: string; name: string; email: string | null; phone: string | null; role: string }[]> {
    return this.db().asUser(me, (tx) => new ProfilesRepository(tx).byIds(ids));
  }
}
