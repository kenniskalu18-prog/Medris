import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./carousel.routes.js";

/** Carousel - see carousel.routes.ts for the contract. */
export const carouselController = controller()
  .route(routes.listSlides, async ({ services, identity, input }) => ok(await services.carousel.slides(identity, input.query.includeInactive)))
  .route(routes.addSlides, async ({ services, user, input }) => created(await services.carousel.add(user(), input.body.slides)))
  .route(routes.updateSlide, async ({ services, user, input }) => ok(await services.carousel.update(user(), input.params.slideId, input.body)))
  .route(routes.reorderSlides, async ({ services, user, input }) => ok(await services.carousel.reorder(user(), input.body.order)))
  .route(routes.deleteSlide, async ({ services, user, input }) => ok(await services.carousel.remove(user(), input.params.slideId)));
