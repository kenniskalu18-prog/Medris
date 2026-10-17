-- Tables whose changes Realtime streams to the browser (postgres_changes).
alter publication supabase_realtime add table public.disputes;
alter publication supabase_realtime add table public.equipment_requests;
alter publication supabase_realtime add table public.favorites;
alter publication supabase_realtime add table public.inventory;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.monthly_listing_submissions;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.order_items;
alter publication supabase_realtime add table public.order_notes;
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.package_comment_likes;
alter publication supabase_realtime add table public.payments;
alter publication supabase_realtime add table public.points_weekly;
alter publication supabase_realtime add table public.product_comment_likes;
alter publication supabase_realtime add table public.product_comments;
alter publication supabase_realtime add table public.product_variants;
alter publication supabase_realtime add table public.products;
alter publication supabase_realtime add table public.request_offers;
alter publication supabase_realtime add table public.service_offers;
alter publication supabase_realtime add table public.vendor_follows;
alter publication supabase_realtime add table public.vendor_packages;
alter publication supabase_realtime add table public.vendors;
-- Realtime access policies (broadcast / presence channels).
