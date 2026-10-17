import { defineRoute } from "../../shared/http/route.js";
import { requireUser } from "../../middleware/auth.js";
import { commonErrors, dataResponse, errorResponses, idList, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";
import { MeSchema } from "./users.schemas.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";

export const getMe = defineRoute({
  method: "get",
  path: "/me",
  tags: ["Account"],
  summary: "The signed-in user's profile",
  description: "public.users, read through RLS as the user.",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(MeSchema, "The profile."), ...errorResponses(401, 404), ...commonErrors },
});

const profileLimit = rateLimit({ name: "profile-write", limit: 30, windowMs: 60_000 });
const Row = z.record(z.string(), z.unknown());

export const getProfile = defineRoute({
  method: "get",
  path: "/me/profile",
  tags: ["Account"],
  summary: "The signed-in user's whole profile row",
  description: 'Replaces `from("users").select("*").eq("id", me).single()` (and the `select("id")` existence checks). Null without a profile.',
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(Row.nullable(), "The row."), ...errorResponses(401), ...commonErrors },
});

export const updateProfile = defineRoute({
  method: "patch",
  path: "/me/profile",
  tags: ["Account"],
  summary: "Change one's profile",
  description:
    "Replaces the app's updates of public.users: name, phone, city, address, photo, Levi data consent, school. Only these fields " +
    "(the table allowed every column - BASELINE_FINDINGS S9). A phone already used by another account: 409.",
  security: signedIn,
  middleware: [requireUser, profileLimit] as const,
  request: {
    body: jsonBody(
      z.object({
        name: z.string().max(120).optional(),
        phone: z.string().max(30).nullable().optional(),
        city: z.string().max(100).nullable().optional(),
        address: z.string().max(500).nullable().optional(),
        avatar_url: z.string().max(1000).nullable().optional(),
        ai_data_consent: z.boolean().optional(),
        campus_id: z.string().max(200).nullable().optional(),
      }),
    ),
  },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 409, 415, 429), ...commonErrors },
});

export const selectRole = defineRoute({
  method: "post",
  path: "/me/role-selected",
  tags: ["Account"],
  summary: "Confirm the account's role (first-run screen)",
  description: 'Replaces `update({ role: authoritativeRole, role_selected: true })`: the role is the account\'s real one, worked out here.',
  security: signedIn,
  middleware: [requireUser, profileLimit] as const,
  responses: { 200: dataResponse(z.object({ role: z.string().nullable() }), "The role."), ...errorResponses(401, 429), ...commonErrors },
});

export const peopleCounts = defineRoute({
  method: "get",
  path: "/admin/people/counts",
  tags: ["Admin dashboard"],
  summary: "People and active listings (admins)",
  description: 'Replaces the dashboard\'s `from("users").select("id", { count: "exact", head: true })` (all, buyers, vendors) and active products count.',
  security: signedIn,
  middleware: [requireUser] as const,
  responses: {
    200: dataResponse(z.object({ total_users: z.number().int(), buyers: z.number().int(), vendors: z.number().int(), active_products: z.number().int() }), "The counts."),
    ...errorResponses(401),
    ...commonErrors,
  },
});

export const people = defineRoute({
  method: "get",
  path: "/admin/people",
  tags: ["Admin dashboard"],
  summary: "Everyone (admins)",
  description: 'Replaces `from("users").select("id, name, email, phone, role, city, created_at, suspended_at, suspended_reason").order("created_at", desc)`.',
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.array(Row), "Newest first."), ...errorResponses(401), ...commonErrors },
});

export const adminsList = defineRoute({
  method: "get",
  path: "/admin/admins",
  tags: ["Admin dashboard"],
  summary: "The admins",
  description: 'Replaces `from("users").select("id, name, email").eq("role", "admin").order("name")`.',
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.array(z.object({ id: z.string(), name: z.string(), email: z.string().nullable() })), "By name."), ...errorResponses(401), ...commonErrors },
});

export const usersByIds = defineRoute({
  method: "get",
  path: "/admin/users",
  tags: ["Admin dashboard"],
  summary: "Some people's name and contact (admins)",
  description: 'Replaces `from("users").select("id,name,email,phone[,role]").in("id", ids)` and `select("name,email,phone").eq("id", id)`.',
  security: signedIn,
  middleware: [requireUser] as const,
  request: { query: z.object({ ids: idList("User ids.") }) },
  responses: {
    200: dataResponse(z.array(z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), role: z.string() })), "Those the caller may see."),
    ...errorResponses(400, 401),
    ...commonErrors,
  },
});
