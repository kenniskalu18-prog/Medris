import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRows } from "../json.js";

export interface ProductSearchHit {
  id: string;
  name: string;
  photos: string[] | null;
  sale_price: number | null;
  discount_price: number | null;
  rental_rate: number | null;
  rental_rate_unit: string | null;
  is_service: boolean | null;
  vendor_business_name: string | null;
  vendor_verification_status: string | null;
  vendor_is_active: boolean | null;
  vendor_lat: number | null;
  vendor_lng: number | null;
  relevance: number;
  vendor_id: string;
  vendor_avg_rating: number | null;
  vendor_review_count: number | null;
  listing_type: string | null;
  service_price_unit: string | null;
}

/**
 * Typo-tolerant product search - search_products_full_v2(), unchanged: the query is
 * split into words, widened with search_synonyms and plural stripping, and scored on
 * the product name (prefix, substring, trigram similarity), its category, the shop
 * name (and its previous name for 14 days after a rename), the description and the
 * variety names. Only active products of verified, active shops.
 *
 * Runs as the caller (it was not SECURITY DEFINER), so the tables' read policies apply.
 */
export class SearchRepository {
  constructor(private readonly db: Executor) {}

  products(query: string | null, limit: number): Promise<ProductSearchHit[]> {
    return jsonRows<ProductSearchHit>(
      this.db,
      sql`
  with q as (select trim(regexp_replace(lower(coalesce(${query}::text,'')), '[[:space:]]+', ' ', 'g')) as s),
  toks as (select distinct t from q, unnest(string_to_array(q.s,' ')) t where t <> ''),
  nt as (select greatest(count(*),1)::float n from toks),
  syn as (
    select distinct sy.synonym as w from toks join public.search_synonyms sy on sy.term = toks.t
    union select distinct regexp_replace(t,'(es|s)$','') from toks where length(t) > 3
  ),
  scored as (
    select p.id as pid, p.name as pname, p.photos as pphotos, p.sale_price as psale, p.discount_price as pdisc, p.rental_rate as prate, p.rental_rate_unit as punit, p.is_service as psvc,
      v.business_name vname, v.verification_status::text vver, v.is_active vact, v.lat vlat, v.lng vlng, v.id vid, v.avg_rating::numeric vavg, v.review_count::integer vrev,
      p.listing_type::text plt, p.service_price_unit::text psu, p.view_count pview,
      lower(p.name) nl,
      (select count(*) from toks where position(' ' || toks.t in ' ' || lower(p.name)) > 0)::float
        + 0.7 * (select count(*) from toks where position(' ' || toks.t in ' ' || lower(p.name)) = 0 and length(toks.t) > 2 and word_similarity(toks.t, lower(p.name)) >= 0.5)::float as hits,
      (select count(*) from syn where length(w) > 2 and lower(p.name) like '%' || w || '%') as synhits,
      (c.name ilike '%' || (select s from q) || '%' or pc.name ilike '%' || (select s from q) || '%'
        or exists (select 1 from toks where length(t) > 2 and (c.name ilike '%' || t || '%' or pc.name ilike '%' || t || '%' or sc.name ilike '%' || t || '%'))) as catm,
      (v.business_name ilike '%' || (select s from q) || '%' or (v.name_changed_at > now() - interval '14 days' and v.previous_business_name ilike '%' || (select s from q) || '%')) as vendm,
      (p.description ilike '%' || (select s from q) || '%' or exists (select 1 from toks where length(t) > 2 and p.description ilike '%' || t || '%')
        or exists (select 1 from public.product_variants pv where pv.product_id = p.id and (pv.name ilike '%' || (select s from q) || '%'))) as descm
    from public.products p
    join public.vendors v on v.id = p.vendor_id
    left join public.categories c on c.id = p.category_id
    left join public.categories pc on pc.id = c.parent_category_id
    left join public.sectors sc on sc.id = coalesce(c.sector_id, v.sector_id)
    where p.status = 'active' and v.verification_status = 'verified' and v.is_active = true
  )
  select pid as id, pname as name, pphotos as photos, psale as sale_price, pdisc as discount_price, prate as rental_rate,
    punit as rental_rate_unit, psvc as is_service, vname as vendor_business_name, vver as vendor_verification_status,
    vact as vendor_is_active, vlat as vendor_lat, vlng as vendor_lng,
    ((case when nl like (select s from q) || '%' then 6 else 0 end)
     + (case when nl like '%' || (select s from q) || '%' then 3 else 0 end)
     + 4.0 * least(hits / (select n from nt), 1)
     + (case when synhits > 0 then 1.5 else 0 end)
     + 2.0 * word_similarity((select s from q), nl)
     + similarity(nl, (select s from q))
     + (case when catm then 0.8 else 0 end) + (case when vendm then 0.6 else 0 end) + (case when descm then 0.3 else 0 end))::real as relevance,
    vid as vendor_id, vavg as vendor_avg_rating, vrev as vendor_review_count, plt as listing_type, psu as service_price_unit
  from scored
  where (select s from q) <> '' and (hits > 0 or synhits > 0 or catm or vendm or descm or word_similarity((select s from q), nl) >= 0.4 or similarity(nl, (select s from q)) > 0.25)
  order by relevance desc, pview desc
  limit ${limit}`,
    );
  }
}
