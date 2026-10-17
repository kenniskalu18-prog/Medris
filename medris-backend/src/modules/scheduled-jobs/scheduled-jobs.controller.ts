import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./scheduled-jobs.routes.js";
import { JOBS } from "./scheduled-jobs.service.js";

/** Scheduled jobs - see scheduled-jobs.routes.ts for the contract. */
export const scheduledJobsController = controller()
  .route(routes.listJobs, async () => ok([...JOBS]))
  .route(routes.runJob, async ({ services, input }) => ok({ job: input.params.job, result: await services.scheduledJobs.run(input.params.job) }));
