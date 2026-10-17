import { getDataContext } from "../../database/index.js";
import { OrdersRepository } from "../../database/repositories/orders.repository.js";
import { UsersRepository } from "../../database/repositories/users.repository.js";
import { VendorsRepository } from "../../database/repositories/vendors.repository.js";
import { findPgError } from "../../database/errors.js";
import { SupabaseAuthAdmin, SupabaseAuthError, fetchAuthUser } from "../../integrations/supabase-auth.js";
import { SupabaseStorage } from "../../integrations/storage/index.js";
import { normalizePhone, phoneAlias } from "../../lib/format.js";
import { identityFromAccessToken } from "../auth/caller.js";
import type { ServiceResult } from "../../shared/types/service.js";
import { AppError } from "../../shared/errors/app-error.js";
import { AccountService } from "../account/account.service.js";

/**
 * Account lifecycle: existence checks, registration, profile repair and
 * account deletion. Ported from api/delete-account.js.
 *
 * Profiles (public.users) and everything else in the database go through the
 * backend's data layer; login accounts (auth.users) are still created and
 * deleted through Supabase Auth's admin API, and files through Supabase
 * Storage - the two remaining Supabase services (docs/SUPABASE_AUDIT.md).
 */

async function publicUserBy(column: "email" | "phone", value: string) {
  return getDataContext().asService((tx) => new UsersRepository(tx).findByContact(column, value));
}

/* ------------------------------------------------------------------ exists */

/**
 * Deletion happens only for a request with no action (what the app's "Delete
 * account" screen sends) or an explicit "delete". Any other unknown action is
 * rejected instead of deleting the account.
 */
const DELETE_ACTIONS = new Set(["", "delete", "delete-account"]);

/** POST /api/delete-account (and its aliases): `action` picks what to do. */
export function handleAccountAction(body: Record<string, unknown>): Promise<ServiceResult> {
  const action = String(body.action || "").toLowerCase();
  if (action === "account-exists" || action === "check-email") return accountExists(body);
  if (action === "register") return registerAccount(body);
  if (action === "ensure-profile") return ensureProfile(body);
  if (DELETE_ACTIONS.has(action)) return deleteAccount(body);
  return Promise.resolve({ status: 400, body: { error: "Unknown account action." } });
}

export async function accountExists(body: Record<string, unknown>): Promise<ServiceResult> {
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { status: 400, body: { error: "A valid email address is required." } };
  }
  const profile = await publicUserBy("email", email);
  const authUser = await SupabaseAuthAdmin.fromEnv().findUserByEmail(email);
  return {
    status: 200,
    body: { exists: Boolean(profile || authUser), hasPublicProfile: Boolean(profile), hasAuthAccount: Boolean(authUser) },
  };
}

/* ---------------------------------------------------------------- register */

/** Email is optional, phone is required, no confirmation e-mail is sent. */
export async function registerAccount(body: Record<string, unknown>): Promise<ServiceResult> {
  const cleanEmail = String(body?.email || "").trim().toLowerCase();
  const cleanName = String(body?.name || "").trim();
  const cleanPhone = String(body?.phone || "").trim();
  const normalizedPhone = normalizePhone(cleanPhone);
  const role = body?.role;
  const password = String(body?.password || "");
  const city = String(body?.city || "").trim();
  const referralCode = String(body?.referral_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);

  if (!cleanName) return { status: 400, body: { error: "Full name is required." } };
  if (!normalizedPhone || normalizedPhone.length < 10) return { status: 400, body: { error: "A valid phone number is required." } };
  if (password.length < 8) return { status: 400, body: { error: "Password must be at least 8 characters." } };
  if (role !== "buyer" && role !== "vendor") return { status: 400, body: { error: "Invalid account type." } };
  if (cleanEmail && !cleanEmail.includes("@")) return { status: 400, body: { error: "Enter a valid email address or leave email blank." } };

  // Choosing "vendor" at sign-up is only an application intent. users.role can
  // never be 'vendor' before a vendor application is reviewed and verified.
  const authoritativeRole = role === "vendor" ? "buyer" : role;
  const authAdmin = SupabaseAuthAdmin.fromEnv();
  const data = getDataContext();

  if (await publicUserBy("phone", cleanPhone)) {
    return { status: 409, body: { error: "An account with that phone number already exists. Please log in instead." } };
  }
  if (cleanEmail) {
    const existingProfile = await publicUserBy("email", cleanEmail);
    const existingAuth = await authAdmin.findUserByEmail(cleanEmail);
    if (existingProfile || existingAuth) {
      return { status: 409, body: { error: "A user with this email address has already been registered. Please log in instead." } };
    }
  }

  // Phone-only accounts get a private synthetic login e-mail that never receives mail.
  const authEmail = cleanEmail || phoneAlias(cleanPhone);

  let userId: string;
  try {
    const created = await authAdmin.createUser({
      email: authEmail,
      password,
      email_confirm: true,
      user_metadata: {
        name: cleanName,
        phone: cleanPhone,
        city,
        role: authoritativeRole,
        requested_role: role,
        email_optional: !cleanEmail,
        ...(referralCode ? { referral_code: referralCode } : {}),
      },
    });
    userId = String(created.id);
  } catch (err) {
    if (err instanceof SupabaseAuthError) return { status: err.status || 400, body: { error: err.message } };
    throw err;
  }

  // The sign-up trigger normally creates the profile already; this insert only fills a gap.
  try {
    await data.asService((tx) =>
      new UsersRepository(tx).insertIgnoringDuplicates({
        id: userId,
        name: cleanName,
        email: cleanEmail || null,
        phone: cleanPhone,
        city,
        role: authoritativeRole,
        roleSelected: true,
        hasPassword: true,
      }),
    );
  } catch (err) {
    await authAdmin.deleteUser(userId).catch(() => undefined);
    return { status: 500, body: { error: findPgError(err)?.message || "Could not create the account profile." } };
  }

  // A referral code typed at sign-up is applied right away. A database trigger
  // normally does it already; this is the harmless-to-repeat safety net.
  let referral: unknown = null;
  if (referralCode) {
    try {
      referral = await data.asService((tx) => new UsersRepository(tx).applyReferral(userId, referralCode, role === "vendor"));
    } catch (err) {
      // PostgREST answered a failed call with its error body; keep reporting that shape.
      const pg = findPgError(err);
      referral = pg ? { code: pg.code, message: pg.message, details: pg.detail ?? null, hint: pg.hint ?? null } : {};
    }
  }

  return { status: 201, body: { created: true, userId, loginEmail: authEmail, referral } };
}

/* ------------------------------------------------------------ ensure profile */

/**
 * Re-creates a missing public.users row for the signed-in account (for
 * example after an Auth account was deleted and re-created with a new id).
 * Never deletes anything and never grants a role above "buyer".
 *
 * Previously the browser's "ensure-profile" request fell through to account
 * deletion because api/delete-account.js had no branch for it.
 */
export async function ensureProfile(body: Record<string, unknown>): Promise<ServiceResult> {
  const accessToken = String(body?.accessToken || "");
  if (!accessToken) return { status: 400, body: { error: "accessToken is required." } };

  const identity = await identityFromAccessToken(accessToken);
  if (!identity) return { status: 401, body: { error: "Invalid or expired session. Please log in again." } };
  const data = getDataContext();

  let exists: boolean;
  try {
    exists = await data.asService((tx) => new UsersRepository(tx).exists(identity.userId));
  } catch {
    return { status: 502, body: { error: "Could not check the account profile." } };
  }
  if (exists) return { status: 200, body: { ok: true, created: false } };

  // Profile details come from the Supabase Auth account (its metadata), fetched only in this rare repair path.
  const { user: me } = await fetchAuthUser(accessToken);
  if (!me?.id || me.id !== identity.userId) return { status: 401, body: { error: "Invalid or expired session. Please log in again." } };
  const meta = (me.user_metadata || {}) as Record<string, unknown>;
  const email = String(me.email || meta.email || "");
  const provider = String((me.app_metadata as Record<string, unknown> | null | undefined)?.provider || "");
  try {
    await data.asService((tx) =>
      new UsersRepository(tx).insertIgnoringDuplicates({
        id: me.id,
        name: String(meta.name || meta.full_name || (email ? email.split("@")[0] : "") || "Levromart user"),
        email: email && !email.includes("@accounts.levromart.app") ? email : null,
        phone: String(meta.phone || ""),
        city: String(meta.city || "Lagos"),
        role: "buyer",
        roleSelected: true,
        hasPassword: provider === "" || provider === "email",
        avatarUrl: String(meta.avatar_url || meta.picture || ""),
      }),
    );
  } catch (err) {
    return { status: 500, body: { error: findPgError(err)?.message || "Could not repair the account profile." } };
  }
  return { status: 200, body: { ok: true, created: true } };
}

/* ------------------------------------------------------------------ delete */

export async function deleteAccount(body: Record<string, unknown>): Promise<ServiceResult> {
  const accessToken = body?.accessToken;
  if (!accessToken) return { status: 400, body: { error: "accessToken is required." } };

  const me = await identityFromAccessToken(accessToken);
  if (!me) return { status: 401, body: { error: "Invalid or expired session. Please log in again." } };
  const uid = me.userId;
  const data = getDataContext();

  const vendorIds = await data.asService((tx) => new VendorsRepository(tx).idsOwnedBy(uid)).catch(() => [] as string[]);

  if (vendorIds.length) {
    const activeOrders = await data.asService((tx) => new OrdersRepository(tx).activeForVendors(vendorIds)).catch(() => []);
    if (activeOrders.length) {
      return {
        status: 400,
        body: { error: `You cannot delete your vendor account while ${activeOrders.length} order(s) are still active. Complete or cancel every active order first.` },
      };
    }
    const owed = await data.asService((tx) => new VendorsRepository(tx).owedCommission(vendorIds)).catch(() => 0);
    if (owed > 0) {
      return { status: 400, body: { error: `You have ₦${owed.toLocaleString()} in unsettled commission. Clear it before deleting your vendor account.` } };
    }
  }

  // Capture conversations before the SQL wipe so their storage attachments can be removed too.
  const conversationIds = await data.asService((tx) => new VendorsRepository(tx).conversationIds(uid, vendorIds)).catch(() => [] as string[]);

  // The port of delete_my_account() performs the FK-safe deletion of public tables. It only
  // deletes the caller's own account (or any, for an admin), as the SQL function did.
  try {
    await new AccountService(() => data).deleteAccountData(me, uid);
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return { status: 500, body: { error: err.message } };
    const pg = findPgError(err);
    return {
      status: 500,
      body: { error: pg?.message || pg?.hint || pg?.detail || "Account data could not be fully deleted. Run the updated delete_my_account SQL function in Supabase first." },
    };
  }

  const storageTargets: [string, string[]][] = [
    ["avatars", [uid]],
    ["vendor-docs", [uid]],
    ["vendor-logos", vendorIds],
    ["product-photos", vendorIds],
    ["chat-attachments", conversationIds.map((id) => `conv/${id}`)],
  ];
  for (const [bucket, prefixes] of storageTargets) {
    const storage = SupabaseStorage.fromEnv(bucket);
    for (const prefix of prefixes) {
      const objects = await storage.list(prefix);
      await storage.remove(objects);
    }
  }

  // Hard-delete the Auth identity (cascades its sessions and refresh tokens).
  const removed = await SupabaseAuthAdmin.fromEnv().deleteUser(uid);
  if (!removed.ok) {
    return { status: 500, body: { error: removed.detail || "Marketplace data was deleted, but the authentication account could not be removed." } };
  }
  return { status: 200, body: { deleted: true } };
}
