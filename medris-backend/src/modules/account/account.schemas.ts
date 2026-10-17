import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

export const LegalTermsAccepted = z.object({ accepted: z.literal(true), version: z.string(), accepted_at: z.string() }).openapi("LegalTermsAccepted");
export const LegalTermsConsent = z
  .object({ accepted: z.boolean(), version: z.string().nullable(), accepted_at: z.string().nullable(), current_version: z.string() })
  .openapi("LegalTermsConsent");
export const RoleResult = z.object({ role: z.string() });

export const AccountAppealSchema = z
  .object({ id: z.string(), message: z.string(), status: z.string(), admin_response: z.string().nullable(), created_at: z.string() })
  .openapi("AccountAppeal");
export const SubmitAppealBody = z.object({ message: z.string().max(5000).nullish() }).openapi("SubmitAppealRequest");

export const AuthActivityBody = z
  .object({ eventType: z.string().openapi({ description: "login or logout." }), userAgent: z.string().max(5000).nullish() })
  .openapi("AuthActivityRequest");

export const ResetRequestParams = z.object({ requestId: idParam });
export const ResetTokenQuery = z.object({ token: z.string().max(200).optional() });
export const ResetStatus = z
  .object({ status: z.string(), email: z.string().optional(), expires_at: z.string().optional() })
  .openapi("ManualPasswordResetStatus");
export const CompleteResetBody = z.object({ token: z.string().max(200).nullish(), newPassword: z.string().max(1000).nullish() }).openapi("CompleteManualPasswordResetRequest");
export const CompleteResetResult = z.object({ completed: z.literal(true) });
export const RequestResetBody = z.object({ email: z.string().max(320).nullish() }).openapi("ManualPasswordResetRequest");
export const RequestResetResult = z.object({ request_id: z.string(), token: z.string(), expires_at: z.string() }).openapi("ManualPasswordResetCreated");

export type AccountAppeal = z.infer<typeof AccountAppealSchema>;
export type ResetStatusResult = z.infer<typeof ResetStatus>;
