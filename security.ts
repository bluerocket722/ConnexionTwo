-- Connexion Two — security posture VERIFY + ENFORCE
-- Turns "remember to keep buckets private and RLS on" into something you can run
-- and prove. Part A reports drift; Part B fixes it. Run in each Supabase project.

-- ══════════════════════════════════════════════════════════════════════════════
-- PART A — VERIFY (read-only). Run these first; each should return ZERO rows.
-- ══════════════════════════════════════════════════════════════════════════════

-- A1) Any PUBLIC storage buckets? (public = anyone with the URL can read the file)
--     Expect zero rows. 'documents', 'template-files', 'encrypted-docs' must be private.
select id, name, public
from storage.buckets
where public = true;

-- A2) Any table in `public` with RLS DISABLED?
--     Expect zero rows. Every table the anon key can reach must have RLS on.
select n.nspname as schema, c.relname as table, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity = false;

-- A3) Security tables must have RLS on AND no anon/authenticated policies.
--     Expect zero rows (a row here = a policy exposing a security table to clients).
select p.tablename, p.policyname, p.roles
from pg_policies p
where p.schemaname = 'public'
  and p.tablename in ('audit_logs','security_events','file_security','rate_limits')
  and (p.roles && array['anon','authenticated']::name[]);

-- A4) Sanity: confirm RLS is actually enabled on the security tables.
--     Expect rls_enabled = true for all four.
select c.relname as table, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('audit_logs','security_events','file_security','rate_limits');

-- ══════════════════════════════════════════════════════════════════════════════
-- PART B — ENFORCE. Uncomment and run to fix anything Part A flagged.
-- ══════════════════════════════════════════════════════════════════════════════

-- B1) Force the app buckets private. (Signed URLs still work; public links stop.)
--     Only privatise 'documents' once the signing flow mints signed URLs — see the
--     note in SECURITY_ENCRYPTION.md. 'template-files' and 'encrypted-docs' are safe now.
-- update storage.buckets set public = false where id in ('template-files','encrypted-docs');
-- update storage.buckets set public = false where id = 'documents';   -- needs signing-flow change first

-- B2) Enable RLS on every public table that's missing it (won't touch ones already on).
-- do $$
-- declare r record;
-- begin
--   for r in
--     select c.relname
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
--   loop
--     execute format('alter table public.%I enable row level security', r.relname);
--     raise notice 'RLS enabled on %', r.relname;
--   end loop;
-- end $$;

-- B3) Re-lock the security tables (idempotent — safe to re-run any time).
-- alter table public.audit_logs      enable row level security;
-- alter table public.security_events enable row level security;
-- alter table public.file_security   enable row level security;
-- alter table public.rate_limits     enable row level security;
-- revoke all on public.audit_logs, public.security_events, public.file_security, public.rate_limits
--   from anon, authenticated;
