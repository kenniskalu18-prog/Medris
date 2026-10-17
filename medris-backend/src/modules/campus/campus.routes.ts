import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { DoneSchema, commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/** Schools for campus listings. */

const tags = ["Campus"];
const writeLimit = rateLimit({ name: "campus-write", limit: 20, windowMs: 60_000 });

export const schoolNames = defineRoute({
  method: "get",
  path: "/campus/schools",
  tags,
  summary: "Schools users added (pending or approved)",
  description: "Replaces campus_school_names().",
  security: optionalSignIn,
  responses: { 200: dataResponse(z.array(z.object({ name: z.string(), status: z.string() })), "Schools."), ...commonErrors },
});

export const submitSchool = defineRoute({
  method: "post",
  path: "/campus/schools",
  tags,
  summary: "Add a school that is not in the list",
  description: "Replaces submit_campus_school().",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(z.object({ name: z.string().max(200).nullish() }).openapi("SubmitSchoolRequest")) },
  responses: {
    200: dataResponse(z.array(z.object({ status: z.string(), merged_into: z.string().nullable() })), "Its review state."),
    ...errorResponses(400, 401, 415, 429),
    ...commonErrors,
  },
});

export const pendingSchools = defineRoute({
  method: "get",
  path: "/admin/campus/schools",
  tags,
  summary: "Schools waiting for review (admins)",
  description: "Replaces admin_campus_submissions().",
  security: signedIn,
  responses: { 200: dataResponse(z.array(z.looseObject({})), "Schools."), ...errorResponses(403), ...commonErrors },
});

export const reviewSchool = defineRoute({
  method: "post",
  path: "/admin/campus/schools/review",
  tags,
  summary: "Approve, merge or reject a school (admins)",
  description: "Replaces admin_review_campus_school().",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: {
    body: jsonBody(
      z
        .object({ nameNorm: z.string().max(200), action: z.string().max(20), target: z.string().max(200).nullish() })
        .openapi("ReviewSchoolRequest"),
    ),
  },
  responses: { 200: dataResponse(DoneSchema, "Done."), ...errorResponses(400, 403, 415, 429), ...commonErrors },
});
