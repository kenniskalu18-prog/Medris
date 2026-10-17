import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

export const PendingAppealSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    user_name: z.string().nullable(),
    user_email: z.string().nullable(),
    suspension_reason: z.string().nullable(),
    message: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("PendingAppeal");

export const PasswordResetRequestRowSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    user_id: z.string().nullable(),
    user_name: z.string().nullable(),
    status: z.string(),
    created_at: z.string(),
    approved_at: z.string().nullable(),
    rejected_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    expires_at: z.string(),
  })
  .openapi("PasswordResetRequestRow");

export const AppealParams = z.object({ appealId: idParam });
export const ResetParams = z.object({ requestId: idParam });
export const DenyAppealBody = z.object({ response: z.string().max(5000).nullish() }).openapi("DenyAppealRequest");
export const SuspendBody = z.object({ reason: z.string().max(5000).nullish() }).openapi("SuspendUserRequest");
export const SetRoleBody = z.object({ email: z.string().max(320), role: z.string() }).openapi("SetUserRoleRequest");
export const OkResult = z.object({ ok: z.literal(true) });

export type PendingAppeal = z.infer<typeof PendingAppealSchema>;
export type PasswordResetRequestRow = z.infer<typeof PasswordResetRequestRowSchema>;
