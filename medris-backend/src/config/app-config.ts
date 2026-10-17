import { z } from "zod";
import { DEFAULT_APP_ORIGIN } from "./env.js";

/**
 * Validated platform configuration.
 *
 * `loadConfig(process.env)` parses every variable the platform layer reads,
 * applies defaults and fails with one error that lists every problem (names
 * only, never values). The same function runs in the deploy check
 * (scripts/check-deploy-env.mjs), so a misconfigured production deployment
 * fails its build instead of serving errors.
 */

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", "on", "off", "yes", "no"])
    .optional()
    .transform((v) => (v === undefined ? fallback : ["true", "1", "on", "yes"].includes(v)));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim().replace(/\/$/, "") : undefined))
  .pipe(z.url().optional());

const intInRange = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((item) => item.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_ORIGIN: optionalUrl,

  // PostgreSQL (Supabase-hosted today; any PostgreSQL 15+ works, see docs/DATABASE.md)
  DATABASE_URL: optionalString.pipe(
    z
      .string()
      .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string")
      .optional(),
  ),
  // Live updates LISTEN on one dedicated connection. A transaction pooler (Supabase port 6543, what DATABASE_URL
  // usually is) silently drops notifications, so this must be the direct or session-mode URL (port 5432).
  LIVE_DATABASE_URL: optionalString.pipe(
    z
      .string()
      .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string")
      .optional(),
  ),
  DATABASE_POOL_MAX: intInRange(5, 1, 100),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("require"),
  DATABASE_SSL_CA: optionalString,
  DATABASE_STATEMENT_TIMEOUT_MS: intInRange(10_000, 100, 300_000),
  DATABASE_CONNECTION_TIMEOUT_MS: intInRange(5_000, 100, 60_000),
  DATABASE_IDLE_TIMEOUT_MS: intInRange(10_000, 1_000, 600_000),

  REQUEST_TIMEOUT_MS: intInRange(25_000, 1_000, 300_000),

  // Supabase Auth (identity provider during the transition) and Storage
  SUPABASE_URL: optionalUrl,
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_JWT_SECRET: optionalString,
  SUPABASE_JWT_ISSUER: optionalUrl,
  SUPABASE_JWT_AUDIENCE: z.string().default("authenticated"),

  // Backend-managed sessions: built and tested, off until approved (docs/AUTH.md)
  AUTH_BACKEND_SESSIONS: bool(false),
  AUTH_SESSION_TTL_DAYS: intInRange(30, 1, 365),
  AUTH_SESSION_IDLE_DAYS: intInRange(14, 1, 365),
  AUTH_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default("medris_session"),
  AUTH_COOKIE_SECURE: bool(true),
  AUTH_TRUSTED_ORIGINS: csv,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalUrl,

  CORS_ALLOWED_ORIGINS: csv,

  RATE_LIMIT_ENABLED: bool(true),

  // Swagger UI (/api/v1/docs) and the OpenAPI document (/api/v1/openapi.json).
  // Unset: on everywhere except NODE_ENV=production.
  API_DOCS_ENABLED: z
    .enum(["true", "false", "1", "0", "on", "off", "yes", "no"])
    .optional()
    .transform((v) => (v === undefined ? undefined : ["true", "1", "on", "yes"].includes(v))),

  // Image storage: Cloudinary is optional; R2 and Supabase Storage stay as they are
  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  CLOUDINARY_FOLDER: z.string().default("levromart"),
  IMAGE_STORAGE: z.enum(["r2", "cloudinary"]).default("r2"),
});

export type RawEnv = Record<string, string | undefined>;

export interface AppConfig {
  env: "development" | "test" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
  appOrigin: string;
  database: {
    url?: string;
    /** For live updates' LISTEN connection (session mode; unset = no row changes pushed). */
    liveUrl?: string;
    poolMax: number;
    sslMode: "disable" | "require" | "verify-full";
    sslCa?: string;
    statementTimeoutMs: number;
    connectionTimeoutMs: number;
    idleTimeoutMs: number;
  };
  requestTimeoutMs: number;
  supabase: {
    url?: string;
    anonKey?: string;
    serviceRoleKey?: string;
    jwtSecret?: string;
    jwtIssuer?: string;
    jwtAudience: string;
  };
  auth: {
    backendSessions: boolean;
    sessionTtlDays: number;
    sessionIdleDays: number;
    cookieName: string;
    cookieSecure: boolean;
    trustedOrigins: string[];
    google?: { clientId: string; clientSecret: string; redirectUri: string };
  };
  cors: { allowedOrigins: string[] };
  rateLimit: { enabled: boolean };
  docs: { enabled: boolean };
  cloudinary?: { cloudName: string; apiKey: string; apiSecret: string; folder: string };
  imageStorage: "r2" | "cloudinary";
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid server configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: RawEnv = process.env): AppConfig {
  // Empty strings count as "not set" (Vercel and .env files often hold blanks).
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  }
  const e = parsed.data;
  const issues: string[] = [];

  const google =
    e.GOOGLE_CLIENT_ID || e.GOOGLE_CLIENT_SECRET || e.GOOGLE_REDIRECT_URI
      ? { clientId: e.GOOGLE_CLIENT_ID ?? "", clientSecret: e.GOOGLE_CLIENT_SECRET ?? "", redirectUri: e.GOOGLE_REDIRECT_URI ?? "" }
      : undefined;
  if (google && !(google.clientId && google.clientSecret && google.redirectUri)) {
    issues.push("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI must be set together");
  }

  const cloudinaryParts = [e.CLOUDINARY_CLOUD_NAME, e.CLOUDINARY_API_KEY, e.CLOUDINARY_API_SECRET];
  if (cloudinaryParts.some(Boolean) && !cloudinaryParts.every(Boolean)) {
    issues.push("CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET must be set together");
  }
  if (e.AUTH_BACKEND_SESSIONS && !e.DATABASE_URL) issues.push("AUTH_BACKEND_SESSIONS requires DATABASE_URL");
  if (e.IMAGE_STORAGE === "cloudinary" && !e.CLOUDINARY_CLOUD_NAME) issues.push("IMAGE_STORAGE=cloudinary requires the CLOUDINARY_* variables");
  if (issues.length) throw new ConfigError(issues);

  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    appOrigin: e.APP_ORIGIN ?? DEFAULT_APP_ORIGIN,
    database: {
      url: e.DATABASE_URL,
      liveUrl: e.LIVE_DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
      sslMode: e.DATABASE_SSL_MODE,
      sslCa: e.DATABASE_SSL_CA?.replace(/\\n/g, "\n"),
      statementTimeoutMs: e.DATABASE_STATEMENT_TIMEOUT_MS,
      connectionTimeoutMs: e.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: e.DATABASE_IDLE_TIMEOUT_MS,
    },
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    supabase: {
      url: e.SUPABASE_URL,
      anonKey: e.SUPABASE_ANON_KEY,
      serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
      jwtSecret: e.SUPABASE_JWT_SECRET,
      jwtIssuer: e.SUPABASE_JWT_ISSUER ?? (e.SUPABASE_URL ? `${e.SUPABASE_URL}/auth/v1` : undefined),
      jwtAudience: e.SUPABASE_JWT_AUDIENCE,
    },
    auth: {
      backendSessions: e.AUTH_BACKEND_SESSIONS,
      sessionTtlDays: e.AUTH_SESSION_TTL_DAYS,
      sessionIdleDays: e.AUTH_SESSION_IDLE_DAYS,
      cookieName: e.AUTH_COOKIE_NAME,
      cookieSecure: e.AUTH_COOKIE_SECURE,
      trustedOrigins: [...new Set([e.APP_ORIGIN ?? DEFAULT_APP_ORIGIN, ...e.AUTH_TRUSTED_ORIGINS])],
      google: google as AppConfig["auth"]["google"],
    },
    cors: { allowedOrigins: e.CORS_ALLOWED_ORIGINS },
    rateLimit: { enabled: e.RATE_LIMIT_ENABLED },
    docs: { enabled: e.API_DOCS_ENABLED ?? e.NODE_ENV !== "production" },
    cloudinary: e.CLOUDINARY_CLOUD_NAME
      ? { cloudName: e.CLOUDINARY_CLOUD_NAME, apiKey: e.CLOUDINARY_API_KEY!, apiSecret: e.CLOUDINARY_API_SECRET!, folder: e.CLOUDINARY_FOLDER }
      : undefined,
    imageStorage: e.IMAGE_STORAGE,
  };
}

/**
 * Variables a production deployment must have once the API reads the
 * database directly. Checked by scripts/check-deploy-env.mjs during the
 * Vercel build so a deployment without them never goes live.
 */
export const PRODUCTION_REQUIRED_ENV = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

export function missingProductionEnv(env: RawEnv = process.env): string[] {
  return PRODUCTION_REQUIRED_ENV.filter((name) => !env[name]);
}
