import { z } from "../../shared/openapi/zod.js";
import { idList, idParam } from "../../shared/openapi/schemas.js";

/** Request and response shapes of /api/v1/follows. */

export const VendorParams = z.object({ vendorId: idParam });

export const FollowsSchema = z.object({ vendorIds: z.array(z.string()), count: z.number().int().min(0) }).openapi("Follows");

export const FollowingSchema = z.object({ following: z.boolean() });

export const SetFollowingBody = z.object({ following: z.boolean() }).openapi("SetFollowingRequest");

export const SetFollowingResult = z.object({
  following: z.boolean(),
  result: z.unknown().openapi({ description: "What toggle_vendor_follow() returned." }),
});

export const UnfollowResult = z.object({ following: z.literal(false), removed: z.number().int().min(0) });

/* -------------------------------------------- ported functions (same rows as the database returned) */

export const VendorIdsQuery = z.object({ vendorIds: idList("Vendor ids.") });

const followPreferences = {
  muted_until: z.string().nullable(),
  mute_mode: z.string(),
  notify_new_listing: z.boolean(),
  notify_new_service: z.boolean(),
  notify_new_package: z.boolean(),
  notify_new_variety: z.boolean(),
  notify_price_change: z.boolean(),
  notify_discount: z.boolean(),
};

export const FollowStateSchema = z.object({ follower_count: z.number(), following: z.boolean(), ...followPreferences }).openapi("FollowState");

export const VendorFollowStateSchema = z.object({ vendor_id: z.string(), follower_count: z.number(), following: z.boolean(), ...followPreferences }).openapi("VendorFollowState");

export const FollowerCountSchema = z.object({ vendor_id: z.string(), follower_count: z.number() }).openapi("FollowerCount");

export const FollowerSchema = z.object({ name: z.string(), avatar_url: z.string().nullable(), followed_at: z.string() }).openapi("Follower");

export const FollowerDetailedSchema = z
  .object({
    follower_id: z.string(),
    name: z.string(),
    avatar_url: z.string().nullable(),
    followed_at: z.string(),
    is_vendor: z.boolean(),
    vendor_id: z.string().nullable(),
    business_name: z.string().nullable(),
    sector_name: z.string().nullable(),
    city: z.string().nullable(),
    link_level: z.number().int().openapi({ description: "1 = the owner follows them, 2/3 = through one/two shops, 0 = no link." }),
    via_name: z.string().nullable(),
    is_following: z.boolean(),
  })
  .openapi("FollowerDetailed");

export const FollowerNetworkEntrySchema = z
  .object({
    vendor_id: z.string(),
    business_name: z.string(),
    logo_url: z.string().nullable(),
    city: z.string().nullable(),
    sector_name: z.string().nullable(),
    follower_count: z.number(),
    is_following: z.boolean(),
    is_me: z.boolean().nullable(),
    link_level: z.number().int(),
    via_name: z.string().nullable(),
  })
  .openapi("FollowerNetworkEntry");

export const FollowPreferencesBody = z
  .object({
    muteMode: z.string().default("none").openapi({ description: "none, 1h, 8h or always." }),
    notifyNewListing: z.boolean().default(true),
    notifyNewService: z.boolean().default(true),
    notifyNewPackage: z.boolean().default(true),
    notifyNewVariety: z.boolean().default(true),
    notifyPriceChange: z.boolean().default(true),
    notifyDiscount: z.boolean().default(true),
  })
  .openapi("FollowPreferencesRequest");

export const FollowPreferencesRowSchema = z.record(z.string(), z.unknown()).openapi("FollowPreferencesRow", { description: "The vendor_follow_preferences row." });

export type FollowState = z.infer<typeof FollowStateSchema>;
export type VendorFollowState = z.infer<typeof VendorFollowStateSchema>;
export type FollowerCount = z.infer<typeof FollowerCountSchema>;
export type Follower = z.infer<typeof FollowerSchema>;
export type FollowerDetailed = z.infer<typeof FollowerDetailedSchema>;
export type FollowerNetworkEntry = z.infer<typeof FollowerNetworkEntrySchema>;
