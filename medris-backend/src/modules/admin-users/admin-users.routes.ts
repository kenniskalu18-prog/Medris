import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { requireUser } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { DoneSchema, UserParams, commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";
import { AppealParams, DenyAppealBody, OkResult, PasswordResetRequestRowSchema, PendingAppealSchema, ResetParams, SetRoleBody, SuspendBody } from "./admin-users.schemas.js";

/** Admin: accounts. */

const tags = ["Admin: accounts"];
const writeLimit = rateLimit({ name: "admin-users-write", limit: 60, windowMs: 60_000 });
const readErrors = { ...errorResponses(401, 403), ...commonErrors };
const writeErrors = { ...errorResponses(400, 401, 403, 404, 415, 429), ...commonErrors };
const admin = { security: signedIn, tags } as const;

export const pendingAppeals = defineRoute({
  ...admin,
  method: "get",
  path: "/admin/appeals",
  summary: "Pending suspension appeals",
  description: "Replaces admin_get_pending_appeals(), now admins only (the original was open to anyone).",
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.array(PendingAppealSchema), "Oldest first."), ...readErrors },
});

export const denyAppeal = defineRoute({
  ...admin,
  method: "post",
  path: "/admin/appeals/{appealId}/deny",
  summary: "Deny an appeal",
  description: "Replaces admin_deny_appeal().",
  middleware: [requireUser, writeLimit] as const,
  request: { params: AppealParams, body: jsonBody(DenyAppealBody) },
  responses: { 200: dataResponse(DoneSchema, "Denied."), ...writeErrors },
});

export const suspendUser = defineRoute({
  ...admin,
  method: "post",
  path: "/admin/users/{userId}/suspend",
  summary: "Suspend an account",
  description: "Replaces admin_suspend_user(): also hides the user's shops.",
  middleware: [requireUser, writeLimit] as const,
  request: { params: UserParams, body: jsonBody(SuspendBody) },
  responses: { 200: dataResponse(DoneSchema, "Suspended."), ...writeErrors },
});

export const unsuspendUser = defineRoute({
  ...admin,
  method: "post",
  path: "/admin/users/{userId}/unsuspend",
  summary: "Reinstate an account",
  description: "Replaces admin_unsuspend_user(): approves the pending appeal.",
  middleware: [requireUser, writeLimit] as const,
  request: { params: UserParams },
  responses: { 200: dataResponse(DoneSchema, "Reinstated."), ...writeErrors },
});

export const setUserRole = defineRoute({
  ...admin,
  method: "post",
  path: "/admin/users/role",
  summary: "Make someone an admin, or remove admin access",
  description: "Replaces admin_set_user_role(). Super admin only.",
  middleware: [requireUser, writeLimit] as const,
  request: { body: jsonBody(SetRoleBody) },
  responses: { 200: dataResponse(DoneSchema, "Changed."), ...writeErrors },
});

export const passwordResetRequests = defineRoute({
  ...admin,
  method: "get",
  path: "/admin/password-resets",
  summary: "Manual password reset requests",
  description: "Replaces admin_get_manual_password_reset_requests(). Super admin only; latest 100.",
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.array(PasswordResetRequestRowSchema), "Newest first."), ...readErrors },
});

export const approvePasswordReset = defineRoute({
  ...admin,
  method: "post",
  path: "/admin/password-resets/{requestId}/approve",
  summary: "Approve a password reset",
  description: "Replaces admin_approve_manual_password_reset().",
  middleware: [requireUser, writeLimit] as const,
  request: { params: ResetParams },
  responses: { 200: dataResponse(OkResult, "Approved."), ...writeErrors },
});

export const rejectPasswordReset = defineRoute({
  ...admin,
  method: "post",
  path: "/admin/password-resets/{requestId}/reject",
  summary: "Reject a password reset",
  description: "Replaces admin_reject_manual_password_reset().",
  middleware: [requireUser, writeLimit] as const,
  request: { params: ResetParams },
  responses: { 200: dataResponse(OkResult, "Rejected."), ...writeErrors },
});
