import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, idParam, isoDateTime, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";

/** The admin dashboard's counts, the sign-in log and the admin action log (admins only, by row-level security). */

const tags = ["Admin dashboard"];
const writeLimit = rateLimit({ name: "admin-log-write", limit: 120, windowMs: 60_000 });

export const dashboardCounts = defineRoute({
  method: "get",
  path: "/admin/dashboard/counts",
  tags,
  summary: "The dashboard's head counts",
  description:
    "Replaces the dashboard's `select(\"id\", { count: \"exact\", head: true })` queries on auth_activity_logs (sign-ins today and in all), " +
    "support_requests (open), suggestions (new), disputes (not resolved), orders (escalated) and vendors (pending applications). `since` is the start of the admin's day. " +
    "Not an admin: all 0.",
  security: signedIn,
  request: { query: z.object({ since: isoDateTime }) },
  responses: {
    200: dataResponse(
      z.object({
        logins_today: z.number().int(),
        login_events: z.number().int(),
        open_support_requests: z.number().int(),
        new_suggestions: z.number().int(),
        open_disputes: z.number().int(),
        escalated_unresolved_payments: z.number().int(),
        escalated_unpaid_confirmed: z.number().int(),
        pending_shop_applications: z.number().int(),
      }),
      "The counts.",
    ),
    ...errorResponses(400, 401),
    ...commonErrors,
  },
});

export const loginLog = defineRoute({
  method: "get",
  path: "/admin/login-log",
  tags,
  summary: "The sign-in log",
  description: 'Replaces `from("auth_activity_logs").select("id,user_id,event_type,occurred_at,user_agent,ip,source").order("occurred_at", desc).limit(2000)[.gte("occurred_at", since)]`.',
  security: signedIn,
  request: { query: z.object({ since: isoDateTime.optional() }) },
  responses: { 200: dataResponse(z.array(z.record(z.string(), z.unknown())), "Newest first, up to 2000."), ...errorResponses(400, 401), ...commonErrors },
});

export const actionLog = defineRoute({
  method: "get",
  path: "/admin/action-log",
  tags,
  summary: "What admins did lately",
  description: 'Replaces `from("admin_actions").select("*").order("created_at", desc).limit(100)`.',
  security: signedIn,
  responses: { 200: dataResponse(z.array(z.record(z.string(), z.unknown())), "Newest first, up to 100."), ...errorResponses(401), ...commonErrors },
});

export const logAction = defineRoute({
  method: "post",
  path: "/admin/action-log",
  tags,
  summary: "Record an admin action",
  description: "Replaces the insert into admin_actions (the name is the admin's profile name). Not an admin: 403.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: {
    body: jsonBody(
      z.object({ action: z.string().min(1).max(100), targetType: z.string().min(1).max(100), targetId: idParam.nullable().optional(), targetLabel: z.string().max(300).nullable().optional() }),
    ),
  },
  responses: { 200: dataResponse(z.object({ logged: z.literal(true) }), "Recorded."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
});

export const disputesQueue = defineRoute({
  method: "get",
  path: "/admin/disputes/queue",
  tags,
  summary: "Open disputes and escalated payment issues",
  description:
    'Replaces the "Disputes & payment issues" page\'s selects: `from("disputes").select("*, order:orders(..., vendor:vendors(business_name), payments(...))").eq("status", "open")`, ' +
    "and orders `payment_unresolved` / `confirmed` with payment_escalated_at, each with its shop and payments. Not an admin: empty lists.",
  security: signedIn,
  responses: {
    200: dataResponse(z.object({ disputes: z.array(z.record(z.string(), z.unknown())), unresolvedPayments: z.array(z.record(z.string(), z.unknown())), unpaidConfirmed: z.array(z.record(z.string(), z.unknown())) }), "Oldest first."),
    ...errorResponses(401),
    ...commonErrors,
  },
});
