import { vi } from "vitest";

/**
 * Stubs global fetch so tests never reach Supabase, Paystack, Resend or
 * Gemini. Each route is matched by method + URL substring/regex and answers
 * with a JSON body; every request is recorded for assertions.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  body: string | undefined;
  headers: Record<string, string>;
}

export interface StubRoute {
  method?: string;
  match: string | RegExp;
  status?: number;
  json?: unknown;
  /** Runs before answering, e.g. to do in the test database what Supabase itself would do. */
  effect?: (body: string | undefined) => Promise<void>;
}

export function stubFetch(routes: StubRoute[]) {
  const calls: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init.method || "GET").toUpperCase();
    calls.push({ method, url, body: typeof init.body === "string" ? init.body : undefined, headers: (init.headers as Record<string, string>) || {} });
    const route = routes.find((r) => (!r.method || r.method === method) && (typeof r.match === "string" ? url.includes(r.match) : r.match.test(url)));
    if (!route) return new Response(JSON.stringify({ message: `unstubbed ${method} ${url}` }), { status: 599 });
    if (route.effect) await route.effect(typeof init.body === "string" ? init.body : undefined);
    const status = route.status ?? 200;
    const empty = route.json === undefined || status === 204;
    return new Response(empty ? null : JSON.stringify(route.json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export const TEST_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  PAYSTACK_SECRET_KEY: "sk_test_123",
  EMAIL_WEBHOOK_SECRET: "webhook-secret",
  CRON_SECRET: "cron-secret",
} as const;

export function setTestEnv(extra: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({ ...TEST_ENV, ...extra })) vi.stubEnv(k, v);
}

export function jsonRequest(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "app.test", ...(init.headers as Record<string, string>) },
    body: JSON.stringify(body),
    ...init,
  });
}
