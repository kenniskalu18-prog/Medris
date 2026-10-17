import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

/** Request and response shapes of the service-booking endpoints. */

export const OfferParams = z.object({ offerId: idParam });
export const CreateOfferBody = z
  .object({ listingId: idParam, description: z.string().max(4000).nullish(), price: z.number().nullish() })
  .openapi("CreateServiceOfferRequest");
export const RespondBody = z
  .object({
    action: z.string().max(20).openapi({ description: "accept, decline or counter." }),
    price: z.number().nullish().openapi({ description: "The counter-offer." }),
    expectedPrice: z.number().nullish().openapi({ description: "The price the caller saw; refused (409) if it changed meanwhile." }),
  })
  .openapi("RespondServiceOfferRequest");
export const ReportPaymentBody = z.object({ amount: z.number().nullish() }).openapi("ReportServicePaymentRequest");
export const OfferIdSchema = z.object({ id: z.string() }).openapi("ServiceOfferId");
export const OfferResultSchema = z.looseObject({ success: z.literal(true), status: z.string() }).openapi("ServiceOfferResult");
export type OfferResult = z.infer<typeof OfferResultSchema>;
