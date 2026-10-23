import { requireEnv } from "../../config/env.js";
import { PaystackClient } from "./paystack.client.js";

export * from "./paystack.client.js";
export * from "./errors.js";
export * from "./money.js";
export * from "./fees.js";
export * from "./signature.js";

/** The shared client. The key is read when a call is made (like the original functions), so a missing key only fails Paystack features. */
let shared: PaystackClient | null = null;
let sharedKey = "";
export function getPaystackClient(): PaystackClient {
  const key = requireEnv("PAYSTACK_SECRET_KEY");
  if (!shared || sharedKey !== key) {
    shared = new PaystackClient({ secretKey: key });
    sharedKey = key;
  }
  return shared;
}
