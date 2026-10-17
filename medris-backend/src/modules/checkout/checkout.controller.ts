import { controller, created } from "../../shared/http/route.js";
import * as routes from "./checkout.routes.js";

const delivery = (d: { method: string; address?: string | null; phone?: string | null; lat?: number | null; lng?: number | null }) => ({
  ...d,
  address: d.address ?? null,
  phone: d.phone ?? null,
});

/** Checkout - see checkout.routes.ts for the contract. */
export const checkoutController = controller()
  .route(routes.sale, async ({ services, identity, input }) => created(await services.checkout.sale(identity, { ...input.body, delivery: delivery(input.body.delivery) })))
  .route(routes.rental, async ({ services, identity, input }) => created(await services.checkout.rental(identity, { ...input.body, delivery: delivery(input.body.delivery) })))
  .route(routes.cart, async ({ services, identity, input }) => created(await services.checkout.cart(identity, { ...input.body, delivery: delivery(input.body.delivery) })))
  .route(routes.pkg, async ({ services, identity, input }) => created(await services.checkout.package(identity, { ...input.body, delivery: delivery(input.body.delivery) })));
