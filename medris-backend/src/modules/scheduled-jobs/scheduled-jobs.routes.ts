import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { requireJobSecret } from "../../middleware/cron-auth.js";
import { commonErrors, dataResponse, errorResponses } from "../../shared/openapi/schemas.js";
import { only } from "../../shared/openapi/security.js";
import { JOB_NAMES } from "./scheduled-jobs.service.js";

/**
 * The database's scheduled jobs (pg_cron), runnable by the backend's scheduler. Until the switch
 * pg_cron keeps running the database versions; these are for after it (and for testing).
 */

const tags = ["Scheduled jobs"];
const JobSchema = z.object({ name: z.enum(JOB_NAMES), schedule: z.string(), description: z.string() }).openapi("ScheduledJob");

export const listJobs = defineRoute({
  method: "get",
  path: "/jobs",
  tags,
  summary: "The scheduled jobs and when they run",
  description: "Their pg_cron names and schedules (UTC). Send the secret as `x-cron-secret: <CRON_SECRET>`.",
  security: only("cronSecret"),
  middleware: [requireJobSecret] as const,
  responses: { 200: dataResponse(z.array(JobSchema), "The jobs."), ...errorResponses(401), ...commonErrors },
});

export const runJob = defineRoute({
  method: "post",
  path: "/jobs/{job}",
  tags,
  summary: "Run one scheduled job now",
  description:
    "Send the secret as `x-cron-secret: <CRON_SECRET>`; without CRON_SECRET configured every call is refused (503). " +
    "Runs the job in one transaction and returns what it returned: how many orders or requests it handled, the commission " +
    "reminder summary, or null. Replaces the pg_cron jobs auto_cancel_unconfirmed_orders(), auto_complete_eligible_orders(), " +
    "send_background_reminders(), process_commission_deadline_reminders(), finalize_points_weeks(), " +
    "escalate_unresolved_payment_orders(), points_reconcile_listings(), process_service_offer_deadlines() and remind_unattended_orders().",
  security: only("cronSecret"),
  middleware: [requireJobSecret] as const,
  request: { params: z.object({ job: z.enum(JOB_NAMES) }) },
  responses: { 200: dataResponse(z.object({ job: z.enum(JOB_NAMES), result: z.unknown() }), "The job ran."), ...errorResponses(400, 401), ...commonErrors },
});
