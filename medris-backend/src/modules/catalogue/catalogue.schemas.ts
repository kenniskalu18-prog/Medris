import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

/** Request and response shapes of /api/v1/catalogue. */

export const CatalogueRowSchema = z
  .looseObject({ id: z.string(), name: z.string() })
  .openapi("CatalogueRow", { description: "A sectors / categories row with every column, as the database returns it." });

export const SectorsQuery = z.object({
  order: z.enum(["sort_order", "name"]).default("sort_order").openapi({ description: "Sort by the curated order or by name." }),
});

export const CategoriesQuery = z.object({
  sectorId: idParam.optional().openapi({ description: "Only the categories of this sector." }),
});

export const SearchQuery = z.object({
  q: z.string().max(200).default("").openapi({ description: "What the buyer typed. Spelling mistakes, plurals and synonyms are tolerated." }),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const SearchIdsQuery = z.object({ q: z.string().max(200).default("") });

export const SearchHitSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    photos: z.array(z.string()).nullable(),
    sale_price: z.number().nullable(),
    discount_price: z.number().nullable(),
    rental_rate: z.number().nullable(),
    rental_rate_unit: z.string().nullable(),
    is_service: z.boolean().nullable(),
    vendor_business_name: z.string().nullable(),
    vendor_verification_status: z.string().nullable(),
    vendor_is_active: z.boolean().nullable(),
    vendor_lat: z.number().nullable(),
    vendor_lng: z.number().nullable(),
    relevance: z.number(),
    vendor_id: z.string(),
    vendor_avg_rating: z.number().nullable(),
    vendor_review_count: z.number().nullable(),
    listing_type: z.string().nullable(),
    service_price_unit: z.string().nullable(),
  })
  .openapi("ProductSearchHit");

export const SearchIdSchema = z.object({ id: z.string(), relevance: z.number() }).openapi("ProductSearchId");

export const CreateSectorBody = z.object({ name: z.string().max(120).nullish() }).openapi("CreateSectorRequest");

export const CreateCategoryBody = z
  .object({ name: z.string().max(120).nullish(), sectorId: idParam.nullish(), parentCategoryId: idParam.nullish() })
  .openapi("CreateCategoryRequest");

export const CreatedId = z.object({ id: z.string() }).openapi("CreatedId");

export const ListingParams = z.object({ listingId: idParam });

export const ServicePriceHintSchema = z
  .object({ booking_count: z.number(), min_price: z.number().nullable(), max_price: z.number().nullable() })
  .openapi("ServicePriceHint");

export type ServicePriceHint = z.infer<typeof ServicePriceHintSchema>;
