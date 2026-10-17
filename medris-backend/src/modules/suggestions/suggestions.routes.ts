import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { DoneSchema, commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";
import { SubmitSuggestionBody, SubmittedSuggestion, SuggestionParams, SuggestionSchema } from "./suggestions.schemas.js";

/** The suggestion box. */

const tags = ["Suggestions"];
const writeLimit = rateLimit({ name: "suggestions-write", limit: 20, windowMs: 60_000 });

export const submitSuggestion = defineRoute({
  method: "post",
  path: "/suggestions",
  tags,
  summary: "Send a suggestion to a shop or to Levromart",
  description: "Replaces submit_suggestion().",
  security: optionalSignIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(SubmitSuggestionBody) },
  responses: { 201: dataResponse(SubmittedSuggestion, "Sent."), ...errorResponses(400, 415, 429), ...commonErrors },
});

export const vendorSuggestions = defineRoute({
  method: "get",
  path: "/suggestions/my-shop",
  tags,
  summary: "Suggestions sent to the caller's shop",
  description: "Replaces get_vendor_suggestions(). Newest first; anonymous senders have no name.",
  security: signedIn,
  responses: { 200: dataResponse(z.array(SuggestionSchema), "Suggestions."), ...errorResponses(404), ...commonErrors },
});

export const platformSuggestions = defineRoute({
  method: "get",
  path: "/suggestions/platform",
  tags,
  summary: "Suggestions sent to Levromart (admins)",
  description: "Replaces get_platform_suggestions().",
  security: signedIn,
  responses: { 200: dataResponse(z.array(SuggestionSchema), "Suggestions."), ...errorResponses(403), ...commonErrors },
});

export const markSuggestionRead = defineRoute({
  method: "post",
  path: "/suggestions/{suggestionId}/read",
  tags,
  summary: "Mark a suggestion as read",
  description: "Replaces mark_suggestion_read(): the receiving shop, or an admin for suggestions to Levromart.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: SuggestionParams },
  responses: { 200: dataResponse(DoneSchema, "Marked."), ...errorResponses(400, 403, 404, 429), ...commonErrors },
});
