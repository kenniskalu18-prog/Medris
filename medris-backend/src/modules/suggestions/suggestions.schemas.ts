import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

export const SuggestionSchema = z
  .object({
    id: z.string(),
    sender_name: z.string().nullable(),
    is_anonymous: z.boolean(),
    message: z.string(),
    status: z.string(),
    created_at: z.string(),
  })
  .openapi("Suggestion");

export const SubmitSuggestionBody = z
  .object({
    targetType: z.string().openapi({ description: "vendor or platform." }),
    targetVendorId: idParam.nullish(),
    message: z.string().max(5000).nullish(),
    isAnonymous: z.boolean().nullish(),
  })
  .openapi("SubmitSuggestionRequest");

export const SuggestionParams = z.object({ suggestionId: idParam });

export const SubmittedSuggestion = z.object({ id: z.string() });

export type Suggestion = z.infer<typeof SuggestionSchema>;
