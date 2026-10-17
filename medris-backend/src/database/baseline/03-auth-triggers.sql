-- Triggers on Supabase Auth tables. The functions they call are in 30_functions.sql.
CREATE TRIGGER trg_log_auth_session_start AFTER INSERT ON auth.sessions FOR EACH ROW EXECUTE FUNCTION public.log_auth_session_start();
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER trg_levromart_auth_user_profile AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_levromart_user();
CREATE TRIGGER trg_zz_apply_signup_referral AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.trg_apply_signup_referral();
