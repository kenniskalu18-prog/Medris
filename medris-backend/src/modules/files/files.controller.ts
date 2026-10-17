import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./files.routes.js";

/** Files - see files.routes.ts for the contract. */
export const filesController = controller()
  .route(routes.uploadLink, async ({ services, user, input }) => ok(await services.files.uploadLink(user(), input.body.bucket, input.body.path, input.body.contentType, input.body.upsert)))
  .route(routes.signedUrls, async ({ services, identity, input }) => ok(await services.files.signedUrls(identity, input.body.bucket, input.body.paths, input.body.expiresIn)))
  .route(routes.removeFiles, async ({ services, user, input }) => ok(await services.files.remove(user(), input.body.bucket, input.body.paths)))
  .route(routes.listFiles, async ({ services, input }) => ok(await services.files.list(input.body.bucket, input.body.prefix)));
