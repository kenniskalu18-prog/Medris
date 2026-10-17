/**
 * Contracts of /api/v1, shared (type-only) with medris-frontend as
 * `@medris/contracts`. Responses are wrapped: success `{ data }`, failure
 * `{ error: { code, message, details? }, requestId }`.
 */

export interface V1Success<T> {
  data: T;
}

export interface V1ErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId?: string;
}

/* --------------------------------------------------------------- catalogue */

/** A sectors / categories row with every column, as the database returns it. */
export type CatalogueRow = Record<string, unknown> & { id: string; name: string };

/* -------------------------------------------------------------------- cart */

export interface CartVendor {
  id: string;
  business_name: string;
  previous_business_name: string | null;
  name_changed_at: string | null;
  is_active: boolean;
  verification_status: string;
  delivery_fee: number | null;
  delivery_fee_mode: string | null;
  delivery_fee_per_km: number | null;
  lat: number | null;
  lng: number | null;
}

export interface CartProduct {
  id: string;
  name: string;
  listing_type: string | null;
  is_service: boolean | null;
  sale_price: number | null;
  discount_price: number | null;
  rental_rate: number | null;
  photos: string[] | null;
  quantity_available: number | null;
  status: string;
  delivery_fee: number | null;
  delivery_fee_mode: string | null;
  delivery_fee_per_km: number | null;
  vendor: CartVendor | null;
}

export interface CartItem {
  id: string;
  variant_id: string | null;
  quantity: number;
  created_at: string;
  /** Every product_variants column, or null. */
  variant: Record<string, unknown> | null;
  /** Null when the product is no longer visible (the cart shows it as unavailable). */
  product: CartProduct | null;
}

export interface AddToCartRequest {
  productId: string;
  quantity?: number;
  variantId?: string | null;
}

/* ------------------------------------------------- favorites and follows */

export interface FavoritesResponse {
  productIds: string[];
  packageIds: string[];
}

export interface FollowsResponse {
  vendorIds: string[];
  count: number;
}

/* ------------------------------------------------------------ notifications */

/** A notifications row with every column. */
export type NotificationRowV1 = Record<string, unknown> & { id: string; type: string; title: string; read: boolean; created_at: string };

export type MarkNotificationsRequest = { all: true } | { ids: string[]; read?: boolean };

/* --------------------------------------------------------------- auth / me */

export interface SessionInfo {
  authenticated: boolean;
  userId: string | null;
  method: "bearer" | "cookie" | null;
  source: "supabase-jwt" | "backend-session" | null;
  backendSessionsEnabled: boolean;
}

export interface MeResponse {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: "buyer" | "vendor" | "admin";
  city: string | null;
  avatarUrl: string | null;
  roleSelected: boolean;
  hasPassword: boolean;
  isSuperAdmin: boolean;
  suspendedAt: string | null;
}
