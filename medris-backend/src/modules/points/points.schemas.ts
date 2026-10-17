import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

/** Request and response shapes of the points endpoints (objects exactly as the database functions returned them). */

export const LeaderboardQuery = z.object({
  period: z.enum(["week", "last_week", "month", "all"]).default("week"),
  limit: z.coerce.number().int().optional().openapi({ description: "1 to 300; 100 by default." }),
});
export const LimitQuery = z.object({ limit: z.coerce.number().int().optional() });
export const ActivityQuery = z.object({
  limit: z.coerce.number().int().optional().openapi({ description: "1 to 100; 40 by default." }),
  before: z.iso.datetime({ offset: true }).optional().openapi({ description: "Only entries before this time (paging)." }),
});
export const CodeQuery = z.object({ code: z.string().max(64).default("") });
export const ApplyCodeBody = z.object({ code: z.string().max(64).nullish() }).openapi("ApplyReferralCodeRequest");
export const AdjustBody = z
  .object({ userId: idParam, points: z.number().int().nullish(), note: z.string().max(500).nullish() })
  .openapi("AdjustPointsRequest");
export const SocialBody = z.object({ phone: z.string().max(40).nullish(), platform: z.string().max(40).nullish() }).openapi("AwardSocialPointsRequest");
export const SearchQuery = z.object({ q: z.string().max(200).default("") });

export const LeaderboardRowSchema = z
  .object({
    rank: z.number().int(),
    user_id: z.string(),
    vendor_id: z.string(),
    business_name: z.string().nullable(),
    logo_url: z.string().nullable(),
    city: z.string().nullable(),
    avg_rating: z.number().nullable(),
    review_count: z.number().nullable(),
    points: z.number(),
    tx_count: z.number(),
    is_me: z.boolean(),
  })
  .openapi("LeaderboardRow");

export const LooseObject = z.looseObject({}).openapi("PointsObject", { description: "As the database function returned it." });
