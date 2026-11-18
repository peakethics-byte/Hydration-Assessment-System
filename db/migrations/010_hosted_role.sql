-- 010 Hosted PostgreSQL (Supabase): the connecting owner role must be a member of app_rw so each
-- signed-in request can run `set local role app_rw` and fall under row-level security.
-- Locally (PGlite) the owner is a superuser and this changes nothing.
grant app_rw to current_user;
