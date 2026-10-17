import { and, eq, isNull, sql } from "drizzle-orm";
import { authIdentities, authUsers, users } from "../schema/index.js";
import type { Executor } from "../client.js";
import { ReferralsRepository } from "./referrals.repository.js";

export interface UserProfile {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: "buyer" | "vendor" | "admin";
  city: string | null;
  avatarUrl: string | null;
  roleSelected: boolean;
  hasPassword: boolean;
  isSuperAdmin: boolean;
  suspendedAt: string | null;
}

/** public.users (application profiles). Runs under whatever role the caller's context set. */
export class UsersRepository {
  constructor(private readonly db: Executor) {}

  async findById(id: string): Promise<UserProfile | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        role: users.role,
        city: users.city,
        avatarUrl: users.avatarUrl,
        roleSelected: users.roleSelected,
        hasPassword: users.hasPassword,
        isSuperAdmin: users.isSuperAdmin,
        suspendedAt: users.suspendedAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ?? null;
  }

  async roleOf(id: string): Promise<string | null> {
    const [row] = await this.db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
    return row?.role ?? null;
  }

  async emailAndName(id: string): Promise<{ email: string | null; name: string } | null> {
    const [row] = await this.db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  }

  async findByContact(column: "email" | "phone", value: string): Promise<{ id: string; email: string | null; phone: string | null } | null> {
    const target = column === "email" ? users.email : users.phone;
    const [row] = await this.db.select({ id: users.id, email: users.email, phone: users.phone }).from(users).where(eq(target, value)).limit(1);
    return row ?? null;
  }

  async exists(id: string): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
    return Boolean(row);
  }

  /** Insert-if-missing, like PostgREST's `resolution=ignore-duplicates`. Returns true when a row was created. */
  async insertIgnoringDuplicates(row: typeof users.$inferInsert): Promise<boolean> {
    const inserted = await this.db.insert(users).values(row).onConflictDoNothing().returning({ id: users.id });
    return inserted.length > 0;
  }

  async markOtpVerified(id: string, at: string): Promise<void> {
    await this.db.update(users).set({ otpVerifiedAt: at }).where(eq(users.id, id));
  }

  /** What the admin one-time-code check needs. */
  async otpProfile(id: string): Promise<{ name: string; email: string | null; role: string; otp_verified_at: string | null } | null> {
    const [row] = await this.db
      .select({ name: users.name, email: users.email, role: users.role, otp_verified_at: users.otpVerifiedAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ?? null;
  }

  async markHasPassword(id: string): Promise<void> {
    await this.db.update(users).set({ hasPassword: true }).where(eq(users.id, id));
  }

  /** apply_referral_internal() (ReferralsRepository.apply): credits a referral code typed at sign-up (safe to repeat). */
  applyReferral(userId: string, code: string, skipCustomer: boolean): Promise<unknown> {
    return new ReferralsRepository(this.db).apply(userId, code, skipCustomer);
  }
}

export interface AuthAccount {
  id: string;
  email: string | null;
  encryptedPassword: string | null;
  emailConfirmedAt: string | null;
  bannedUntil: string | null;
}

/**
 * Read-only access to Supabase Auth's own tables (auth.users, auth.identities).
 * Needs the connection role to have SELECT on them (granted to the
 * least-privilege role by migration 0001). Never written by the backend.
 */
export class AuthAccountsRepository {
  constructor(private readonly db: Executor) {}

  async findByEmail(email: string): Promise<AuthAccount | null> {
    const [row] = await this.db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        encryptedPassword: authUsers.encryptedPassword,
        emailConfirmedAt: authUsers.emailConfirmedAt,
        bannedUntil: authUsers.bannedUntil,
      })
      .from(authUsers)
      .where(and(sql`lower(${authUsers.email}) = ${email.trim().toLowerCase()}`, isNull(authUsers.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async findIdByIdentity(provider: string, providerId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .innerJoin(authUsers, eq(authUsers.id, authIdentities.userId))
      .where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerId, providerId), isNull(authUsers.deletedAt)))
      .limit(1);
    return row?.userId ?? null;
  }
}
