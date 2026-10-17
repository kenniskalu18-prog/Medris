import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./suggestions.routes.js";

/** The suggestion box - see suggestions.routes.ts for the contract. */
export const suggestionsController = controller()
  .route(routes.submitSuggestion, async ({ services, identity, input }) => created(await services.suggestions.submit(identity, input.body)))
  .route(routes.vendorSuggestions, async ({ services, identity }) => ok(await services.suggestions.vendorSuggestions(identity)))
  .route(routes.platformSuggestions, async ({ services, identity }) => ok(await services.suggestions.platformSuggestions(identity)))
  .route(routes.markSuggestionRead, async ({ services, identity, input }) => ok(await services.suggestions.markRead(identity, input.params.suggestionId)));
