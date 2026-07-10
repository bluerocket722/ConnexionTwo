-- Connexion Two — Client intake (submissions table + private uploads bucket)
-- Run in the project whose SERVICE_ROLE_KEY the `client-intake` edge function uses
-- (the new EU project once you migrate).
--
-- Trust model: the PUBLIC form never writes here directly. It POSTs to the
-- `client-intake` edge function, which uses the SERVICE ROLE to insert rows and
-- upload files. So — exactly like the security tables — RLS is enabled with NO
-- anon/authenticated policies: only the service role can read/write. New clients
-- can't read each other's submissions, and nobody can scrape them with the anon key.

create table if not exists public.intake_submissions (
  id            uuid primary key default gen_random_uuid(),
  -- Contact
  first_name    text not null,
  last_name     text not null,
  email         text not null,
  phone         text,
  company_name  text,
  country       text,
  -- Hosting preferences
  data_region   text check (data_region in ('EU','USA')),
  platforms     text[]  not null default '{}',   -- e.g. {github,supabase,oracle,digitalocean}
  platform_other text,                            -- free-text "request another platform"
  -- Branding
  logo_path     text,                             -- path in the private intake-uploads bucket
  favicon_path  text,
  -- Account provisioning handoff (temporary credential the client creates for you)
  setup_email       text,
  setup_password_enc text,                        -- AES-256-GCM ciphertext (NOT plaintext)
  -- Misc
  notes         text,
  ip            text,
  user_agent    text,
  status        text not null default 'new'
                check (status in ('new','in_progress','provisioned','archived')),
  created_at    timestamptz not null default now()
);
create index if not exists intake_submissions_created_idx on public.intake_submissions (created_at desc);
create index if not exists intake_submissions_status_idx  on public.intake_submissions (status, created_at desc);

-- Lock it down: service role only.
alter table public.intake_submissions enable row level security;
revoke all on public.intake_submissions from anon, authenticated;

-- Private bucket for logos / favicons. Uploaded ONLY by the edge function (service
-- role); read via short-lived signed URLs. No public access, no anon policy.
insert into storage.buckets (id, name, public)
  values ('intake-uploads', 'intake-uploads', false)
  on conflict (id) do update set public = false;

-- (No storage policies for anon/authenticated on purpose — the service role
--  bypasses RLS, and nobody else should touch this bucket.)

-- Optional housekeeping: once you've provisioned a client, clear the stored
-- credential so it doesn't linger even in encrypted form.
create or replace function public.clear_intake_credential(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.intake_submissions
     set setup_password_enc = null, setup_email = null, status = 'provisioned'
   where id = p_id;
$$;
revoke all on function public.clear_intake_credential(uuid) from anon, authenticated;
