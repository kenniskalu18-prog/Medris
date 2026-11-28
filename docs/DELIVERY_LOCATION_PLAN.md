# Plan: customer chooses the delivery location (for the engineer)

Status: **plan only, not built.** Needs a decision on the map/address service and a key added by the engineer.

## What the customer sees
At cart/checkout, when delivery is chosen: "Deliver to" with two options - **My current location** (browser location) or
**Another address** (search box with suggestions as they type, like Uber, then a map pin they can drag). The delivery
fee shows again as soon as the place changes.

## How the fee is worked out
- The shop's (or product's) location is already stored; the delivery fee per km is already a setting.
- Distance = straight line (haversine) between shop and chosen point. Fee = per-km fee x distance (apply the existing minimum/rounding).
- **The server must calculate it** (`create_cart_order` and the backend checkout): the browser sends the chosen latitude/longitude, never the fee.
  Reject coordinates outside Nigeria, and store the address text + lat/lng on the order for the vendor and for disputes.
- Migration needed: `orders.delivery_lat`, `orders.delivery_lng`; update `create_cart_order` and `checkout.service.ts` together (the parity test
  compares them - see migration 0075 for the same kind of change).

## Map / address service (decision needed)
| Option | Good | Bad |
|---|---|---|
| Google Maps (Places Autocomplete + Maps JS) | Best Nigerian addresses | Paid per use; key must be restricted to levromart.com |
| OpenStreetMap (Photon/Nominatim + Leaflet) | Free | Weaker on Nigerian street names; usage limits; self-host for volume |
Recommended: Google Maps with a referrer-restricted key and a monthly budget alert. The key is a public browser key, but still set it as an
environment variable and restrict it in Google's console - never commit it.

## Privacy / legal
Location of customers is personal data: update Privacy and Terms (and the "Last updated" date) in the same change and have a lawyer review.
