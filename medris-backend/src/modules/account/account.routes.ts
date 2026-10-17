import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { requireUser } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { DoneSchema, commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";
import {
  AccountAppealSchema,
  AuthActivityBody,
  CompleteResetBody,
  CompleteResetResult,
  LegalTermsAccepted,
  LegalTermsConsent,
  RequestResetBody,
  RequestResetResult,
  ResetRequestParams,
  ResetStatus,
  ResetTokenQuery,
  RoleResult,
  SubmitAppealBody,
} from "./account.schemas.js";

/** The signed-in user's own account, and the manual password reset flow (no sign-in). */

const tags = ["Account"];
const writeLimit = rateLimit({ name: "account-write", limit: 30, windowMs: 60_000 });
const resetLimit = rateLimit({ name: "password-reset", limit: 10, windowMs: 15 * 60_000 });
const userErrors = { ...errorResponses(400, 401, 404, 415, 429), ...commonErrors };

export const acceptLegalTerms = defineRoute({
  method: "post",
  path: "/account/legal-terms",
  tags,
  summary: "Accept the current terms and privacy policy",
  description: "Replaces accept_legal_terms().",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  responses: { 200: dataResponse(LegalTermsAccepted, "Accepted."), ...userErrors },
});

export const legalTermsConsent = defineRoute({
  method: "get",
  path: "/account/legal-terms",
  tags,
  summary: "Has the user accepted the current terms?",
  description: "Replaces get_legal_terms_consent().",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(LegalTermsConsent, "Consent."), ...errorResponses(401, 404), ...commonErrors },
});

export const syncRole = defineRoute({
  method: "post",
  path: "/account/role/sync",
  tags,
  summary: "Re-derive the account's role",
  description: "Replaces sync_current_account_role(): vendor while a verified shop exists, buyer otherwise; admins stay admin.",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  responses: { 200: dataResponse(RoleResult, "The role now."), ...userErrors },
});

export const myAppeal = defineRoute({
  method: "get",
  path: "/account/appeal",
  tags,
  summary: "The latest suspension appeal",
  description: "Replaces get_my_account_appeal() (zero or one row).",
  security: signedIn,
  responses: { 200: dataResponse(z.array(AccountAppealSchema), "Zero or one appeal."), ...commonErrors },
});

export const submitAppeal = defineRoute({
  method: "post",
  path: "/account/appeal",
  tags,
  summary: "Appeal a suspension",
  description: "Replaces submit_account_appeal(): one pending appeal at a time, at most 3 a day; every admin is notified.",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { body: jsonBody(SubmitAppealBody) },
  responses: { 200: dataResponse(DoneSchema, "Sent."), ...userErrors },
});

export const recordAuthActivity = defineRoute({
  method: "post",
  path: "/account/auth-activity",
  tags,
  summary: "Log a sign-in or sign-out",
  description: "Replaces record_auth_activity().",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { body: jsonBody(AuthActivityBody) },
  responses: { 200: dataResponse(DoneSchema, "Logged."), ...userErrors },
});

export const requestPasswordReset = defineRoute({
  method: "post",
  path: "/account/password-reset/requests",
  tags,
  summary: "Ask an admin to approve a password reset",
  description: "Replaces request_manual_password_reset(). Returns the request id and its secret token (keep it on the device).",
  security: optionalSignIn,
  middleware: [resetLimit] as const,
  request: { body: jsonBody(RequestResetBody) },
  responses: { 201: dataResponse(RequestResetResult, "Created."), ...errorResponses(400, 415, 429), ...commonErrors },
});

export const passwordResetStatus = defineRoute({
  method: "get",
  path: "/account/password-reset/requests/{requestId}",
  tags,
  summary: "Status of a password reset request",
  description: "Replaces get_manual_password_reset_status(). Needs the request's token.",
  security: optionalSignIn,
  middleware: [resetLimit] as const,
  request: { params: ResetRequestParams, query: ResetTokenQuery },
  responses: { 200: dataResponse(ResetStatus, "invalid, pending, approved, rejected, expired or completed."), ...errorResponses(400, 429), ...commonErrors },
});

export const completePasswordReset = defineRoute({
  method: "post",
  path: "/account/password-reset/requests/{requestId}/complete",
  tags,
  summary: "Set the new password of an approved request",
  description: "Replaces complete_manual_password_reset().",
  security: optionalSignIn,
  middleware: [resetLimit] as const,
  request: { params: ResetRequestParams, body: jsonBody(CompleteResetBody) },
  responses: { 200: dataResponse(CompleteResetResult, "Password changed."), ...errorResponses(400, 415, 429), ...commonErrors },
});
