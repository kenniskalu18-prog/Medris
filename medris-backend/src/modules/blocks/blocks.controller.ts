import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./blocks.routes.js";

/** Blocks - see blocks.routes.ts for the contract. */
export const blocksController = controller()
  .route(routes.listBlocks, async ({ services, user }) => ok(await services.blocks.list(user())))
  .route(routes.blockState, async ({ services, user, input }) => ok(await services.blocks.state(user(), input.params.userId)))
  .route(routes.block, async ({ services, user, input }) => ok(await services.blocks.block(user(), input.params.userId)))
  .route(routes.unblock, async ({ services, user, input }) => ok(await services.blocks.unblock(user(), input.params.userId)));
