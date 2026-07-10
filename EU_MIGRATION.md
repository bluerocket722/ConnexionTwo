-- Connexion Two — Security MVP tables (audit log, security events, file scanning, rate limits)
-- Run this in the SAME Supabase project whose SERVICE_ROLE_KEY your edge functions use.
-- (These are user-scoped security logs, so the auth project — xbwuvaxtnylqvagdvpxp — is
--  the natural home, since `user_id` is an auth.users id. Run it there.)
--
-- Trust model — READ THIS:
--   Unlike the rest of the app (which talks to the DB with the ANON key and scopes
--   rows client-side by owner_email), NOTHING here is meant to be reachable from the
--   browser. Audit trails and security events must not be readable or writable by the
--   anon/authenticated roles, or an attacker could read your incident history or forge
--   entries. So we enable RLS and grant NO policies to anon/authenticated: only the
--   SERVICE ROLE (which bypasses RLS) can touch these tables. That is the whole point.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Audit log — every meaningful action (who did what, to what, from where)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,
  action      text not null,
  target_type text,
  target_id   text,
  ip          text,
  user_agent  text,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
-- Query patterns: "everything a user did" and "recent activity", so index both.
create index if not exists audit_logs_user_idx    on public.audit_logs (user_id, created_at desc);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_action_idx  on public.audit_logs (action, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Security events — WAF blocks, auth failures, rate-limit trips, scan hits
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.security_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,
  event_type  text not null,
  severity    text not null default 'low'
              check (severity in ('low','medium','high','critical')),
  ip          text,
  message     text,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists security_events_created_idx  on public.security_events (created_at desc);
create index if not exists security_events_severity_idx on public.security_events (severity, created_at desc);
create index if not exists security_events_ip_idx       on public.security_events (ip, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) File security — the malware-scan verdict for every uploaded file
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.file_security (
  id          uuid primary key default gen_random_uuid(),
  file_path   text not null,
  uploaded_by uuid,
  status      text not null default 'pending'
              check (status in ('pending','clean','infected','quarantined','failed')),
  scan_result jsonb,                 -- structured verdict from the scanner (not a string blob)
  viruses     text[],                -- signature names when infected, for quick filtering
  scanned_at  timestamptz,
  created_at  timestamptz not null default now()
);
-- One row is the current truth for a given path; upsert on re-scan.
create unique index if not exists file_security_path_uidx on public.file_security (file_path);
create index if not exists file_security_status_idx on public.file_security (status, created_at desc);
create index if not exists file_security_user_idx   on public.file_security (uploaded_by, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Rate limiting — a fixed-window counter the edge middleware increments atomically
-- ─────────────────────────────────────────────────────────────────────────────
-- In-memory counters reset on every cold start and aren't shared across isolates,
-- so they don't actually limit anything. A tiny DB table + one atomic function does.
create table if not exists public.rate_limits (
  bucket_key   text        not null,   -- e.g. 'ip:1.2.3.4:document_upload'
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (bucket_key, window_start)
);
create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

-- Returns TRUE when the request is ALLOWED, FALSE when the limit is exceeded.
-- Atomic: the insert…on conflict…returning increments and reads in one statement,
-- so concurrent requests can't race past the limit.
create or replace function public.check_rate_limit(
  p_key            text,
  p_limit          int,
  p_window_seconds int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count  int;
begin
  -- Snap "now" down to the start of the current fixed window.
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits (bucket_key, window_start, count)
    values (p_key, v_window, 1)
  on conflict (bucket_key, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) RLS — lock everything to the service role only (deny anon/authenticated)
-- ─────────────────────────────────────────────────────────────────────────────
-- Enabling RLS with zero policies means anon/authenticated get NOTHING; the
-- service role bypasses RLS entirely, so only your edge functions can read/write.
alter table public.audit_logs      enable row level security;
alter table public.security_events enable row level security;
alter table public.file_security   enable row level security;
alter table public.rate_limits     enable row level security;

-- Belt-and-braces: also revoke the PostgREST-exposed roles so these tables never
-- surface on the REST API even if a permissive policy is added by mistake later.
revoke all on public.audit_logs, public.security_events, public.file_security, public.rate_limits
  from anon, authenticated;
revoke all on function public.check_rate_limit(text, int, int) from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Housekeeping — keep the log/counter tables from growing forever
-- ─────────────────────────────────────────────────────────────────────────────
-- Deletes old rate-limit windows and ages out logs. Schedule with pg_cron if you
-- have it (see the commented job below), or call it from a nightly edge function.
create or replace function public.purge_security_data(
  p_audit_days  int default 365,   -- keep audit trail a year (compliance-friendly)
  p_events_days int default 180,
  p_files_days  int default 90
) returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limits    where window_start < now() - interval '1 day';
  delete from public.audit_logs     where created_at   < now() - make_interval(days => p_audit_days);
  delete from public.security_events where created_at  < now() - make_interval(days => p_events_days);
  delete from public.file_security  where created_at   < now() - make_interval(days => p_files_days)
                                      and status in ('clean','failed');
$$;

-- If the pg_cron extension is enabled in this project, uncomment to run nightly:
-- select cron.schedule('purge-security-data', '17 3 * * *', $$select public.purge_security_data();$$);
