import { controller, json } from "../../shared/http/route.js";
import * as routes from "./live.routes.js";

/** /api/v1/live over plain HTTP: says how to connect (the socket itself is live.socket.ts). */
export const liveController = controller().route(routes.liveInfo, () => json(routes.liveSummary()));
