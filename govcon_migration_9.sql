-- ═══════════════════════════════════════════════════════════════════════════
-- GovCon migration 9 — Qualification engine foundation (Phase 2 of the
-- Blu Balances automation spec).
--
-- Adds: structured opportunity analysis + versions, score components,
-- hard gates, requirement rows (capability matrix), submission requirement
-- rows (compliance matrix), next actions, subcontractor needs, source
-- documents (with user review/selection state), amendments, award matches,
-- no-bid reasons, audit log, run logs — plus the new review-stage columns on
-- govcon_rfps and the expanded company profile fields.
--
-- Run ONCE in the SQL editor of project rfdvogakvyodixgpvqvz. Idempotent —
-- safe to re-run. Ends with a schema-cache reload.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── shared updated_at trigger ────────────────────────────────────────────────
create or replace function public.govcon_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ── 1) govcon_rfps: review workflow + richer solicitation fields ────────────
alter table public.govcon_rfps
  add column if not exists psc                       text,
  add column if not exists opportunity_type          text,            -- RFI | RFQ | RFP | combined | simplified | other
  add column if not exists estimated_value           numeric,
  add column if not exists question_deadline         date,
  add column if not exists site_visit_date           date,
  add column if not exists site_visit_mandatory      boolean,
  add column if not exists contract_period           text,
  add column if not exists raw_source                jsonb,           -- original scraped payload
  add column if not exists review_stage              text not null default 'Discovered',
  -- Discovered | Documents Downloaded | Ready for Document Review | Documents Selected
  -- | Analysis Requested | Analysis Complete | Awaiting Human Decision
  -- | Approved for Pipeline | Rejected / No-Bid | Archived
  add column if not exists documents_downloaded_at   timestamptz,
  add column if not exists selected_document_count   integer not null default 0,
  add column if not exists analysis_status           text not null default 'Not Started',
  -- Not Started | Awaiting Document Review | Documents Selected | Queued | Processing
  -- | Complete | Preliminary | Failed | Needs Refresh | Amendment Review Required
  add column if not exists latest_analysis_id        uuid,
  add column if not exists latest_analysis_version   integer,
  add column if not exists last_analyzed_at          timestamptz,
  add column if not exists reviewed_at               timestamptz,
  add column if not exists reviewed_by               uuid,
  add column if not exists approved_for_pipeline_at  timestamptz,
  add column if not exists approved_for_pipeline_by  uuid,
  add column if not exists no_bid_reason             text,
  add column if not exists archived_at               timestamptz;

create index if not exists govcon_rfps_review_stage_idx on public.govcon_rfps (owner, review_stage);
create index if not exists govcon_rfps_deadline_idx     on public.govcon_rfps (owner, deadline);
create index if not exists govcon_rfps_category_idx     on public.govcon_rfps (owner, category);

-- ── 2) company profile: verified facts only (never invented by AI) ──────────
alter table public.govcon_profiles
  add column if not exists dba                  text,
  add column if not exists legal_name           text,
  add column if not exists website              text,
  add column if not exists phone                text,
  add column if not exists uei                  text,             -- null = not yet obtained
  add column if not exists cage                 text,             -- null = not yet obtained
  add column if not exists sam_registered       boolean not null default false,
  add column if not exists bonding_capacity     numeric,          -- null = no bonding source
  add column if not exists service_area         text,
  add column if not exists primary_naics        text[] not null default '{}',
  add column if not exists secondary_naics      text[] not null default '{}',
  add column if not exists search_keywords      text[] not null default '{}',
  add column if not exists excluded_terms       text[] not null default '{}',
  add column if not exists licenses             jsonb not null default '[]',   -- [{type,number,state,expires}]
  add column if not exists insurance            jsonb not null default '[]',   -- [{type,carrier,limit,expires}]
  add column if not exists certifications_detail jsonb not null default '[]',  -- [{name,issuer,year}]
  add column if not exists past_performance     jsonb not null default '[]',   -- [{customer,scope,value,period,contact}] — user-entered ONLY
  add column if not exists equipment            jsonb not null default '[]',
  add column if not exists deadline_gate_days   jsonb not null default
    '{"rfi":2,"simplified":4,"rfq":7,"rfp":14,"complex_rfp":21}'::jsonb;

-- autopilot behavior mode (revised behavior: manual document selection default)
alter table public.govcon_autopilot_settings
  add column if not exists autopilot_mode text not null default 'mode2_manual';
  -- mode1_discovery | mode2_manual (default: discover+download+notify, human selects/approves)
  -- | mode3_full (only after user opts in)

-- ── 3) versioned opportunity analysis (the decision record) ─────────────────
create table if not exists public.govcon_opportunity_analysis (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null,
  rfp_id        uuid not null references public.govcon_rfps(id) on delete cascade,
  version       integer not null default 1,
  analysis_mode text not null default 'initial',        -- initial | refresh | amendment
  status        text not null default 'complete',       -- complete | preliminary | failed
  fit_score                       integer,
  bid_readiness_score             integer,
  subcontractor_dependency_score  integer,
  analysis_confidence             integer,
  recommendation        text,   -- Pursue | Conditional Pursue | Monitor | Team | No-Bid | Strong Pursue
  recommendation_reason text,
  score_breakdown       jsonb not null default '{}',    -- {service_naics_fit:{points,max,evidence,missing}, …}
  bid_readiness_breakdown jsonb not null default '{}',
  dependency_breakdown  jsonb not null default '{}',
  hard_gates            jsonb not null default '[]',    -- [{gate,status,reason,curable,action}]
  decision_record       jsonb not null default '{}',    -- full standardized JSON from the spec
  top_strengths         jsonb not null default '[]',
  top_risks             jsonb not null default '[]',
  missing_information   jsonb not null default '[]',
  required_subcontractors jsonb not null default '[]',
  completeness_warnings jsonb not null default '[]',    -- excluded-document warnings
  input_document_ids    uuid[] not null default '{}',   -- exactly what the user selected
  model                 text,
  prompt_version        text,
  input_tokens          integer,
  output_tokens         integer,
  proposal_generation_allowed boolean not null default false,
  created_by            text not null default 'ai',     -- ai | human
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (owner, rfp_id, version)
);
create index if not exists govcon_analysis_rfp_idx on public.govcon_opportunity_analysis (owner, rfp_id, version desc);
create index if not exists govcon_analysis_rec_idx on public.govcon_opportunity_analysis (owner, recommendation, fit_score desc);

-- ── 4) score components (transparent "Why this score?" rows) ────────────────
create table if not exists public.govcon_score_components (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null,
  analysis_id   uuid not null references public.govcon_opportunity_analysis(id) on delete cascade,
  rfp_id        uuid not null,
  score_type    text not null,          -- fit | bid_readiness | dependency
  category      text not null,          -- e.g. service_naics_fit
  points        numeric not null default 0,
  max_points    numeric not null default 0,
  evidence      text,
  missing_evidence text,
  human_override numeric,               -- null = no override
  override_reason text,
  overridden_by uuid,
  overridden_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists govcon_scorecomp_idx on public.govcon_score_components (owner, analysis_id);

-- ── 5) hard gates (queryable, in addition to the JSONB snapshot) ────────────
create table if not exists public.govcon_hard_gates (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null,
  rfp_id       uuid not null references public.govcon_rfps(id) on delete cascade,
  analysis_id  uuid references public.govcon_opportunity_analysis(id) on delete cascade,
  gate         text not null,           -- deadline | registration | set_aside | license | clearance
                                        -- | bonding | past_performance | self_performance | site_visit | geographic
  status       text not null,           -- pass | warning | blocked | fail
  reason       text,
  curable      boolean not null default false,
  action       text,
  human_disposition text,               -- user override of the gate
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists govcon_gates_idx on public.govcon_hard_gates (owner, rfp_id, status);

-- ── 6) capability-matrix rows (structured requirements) ─────────────────────
create table if not exists public.govcon_requirements (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null,
  rfp_id           uuid not null references public.govcon_rfps(id) on delete cascade,
  analysis_id      uuid references public.govcon_opportunity_analysis(id) on delete set null,
  requirement      text not null,
  source_reference text,                 -- page / section / attachment
  requirement_type text,                 -- Technical | Staffing | Management | Administrative | Licensing
                                         -- | Insurance | Bonding | Past Performance | Security | Equipment
                                         -- | Reporting | Quality Control | Safety | Pricing | Submission
                                         -- | Socioeconomic | Geographic | Scheduling
  mandatory        boolean,
  capability       text,                 -- current Blu Balances capability statement (evidence-based)
  delivery_method  text,                 -- direct | subcontract | hybrid
  subcontractor_type text,
  evidence         text,
  status           text not null default 'Verification Required',
  -- Met | Met Through Verified Partner | Partial | Gap | Blocked | Not Applicable | Verification Required
  risk             text,
  required_action  text,
  action_owner     text,
  due_date         date,
  notes            text,
  origin           text not null default 'ai',   -- ai | human | source | imported | partner
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists govcon_reqs_idx on public.govcon_requirements (owner, rfp_id, sort_order);

-- ── 7) submission-compliance rows ────────────────────────────────────────────
create table if not exists public.govcon_submission_requirements (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null,
  rfp_id              uuid not null references public.govcon_rfps(id) on delete cascade,
  analysis_id         uuid references public.govcon_opportunity_analysis(id) on delete set null,
  submission_item     text not null,
  solicitation_section text,
  required_form       text,
  required_format     text,
  page_limit          text,
  signature_required  boolean,
  attachment_required boolean,
  responsible_party   text,
  internal_due_date   date,
  government_due_date date,
  status              text not null default 'Todo',   -- Todo | In Progress | Done | Blocked | N/A
  validation_notes    text,
  origin              text not null default 'ai',
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists govcon_subreqs_idx on public.govcon_submission_requirements (owner, rfp_id, sort_order);

-- ── 8) next actions ──────────────────────────────────────────────────────────
create table if not exists public.govcon_next_actions (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null,
  rfp_id           uuid references public.govcon_rfps(id) on delete cascade,
  action           text not null,
  action_owner     text,
  due_date         date,
  dependency       text,
  status           text not null default 'open',      -- open | in_progress | done | blocked | cancelled
  reason           text,
  source_reference text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists govcon_actions_idx on public.govcon_next_actions (owner, rfp_id, status, due_date);

-- ── 9) subcontractor needs (sourcing checklist per opportunity) ─────────────
create table if not exists public.govcon_subcontractor_needs (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null,
  rfp_id           uuid not null references public.govcon_rfps(id) on delete cascade,
  category         text not null,        -- e.g. janitorial labor, landscaping crew
  location         text,
  search_terms     jsonb not null default '[]',
  required_count   integer not null default 1,       -- 1 = primary; 2 = primary + backup
  verified_count   integer not null default 0,
  status           text not null default 'open',     -- open | searching | quoted | verified | closed
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists govcon_subneeds_idx on public.govcon_subcontractor_needs (owner, rfp_id, status);

-- extend the existing subcontractor tracker with verification fields
alter table public.govcon_subcontractors
  add column if not exists license        text,
  add column if not exists insurance_ok   boolean not null default false,
  add column if not exists certifications text,
  add column if not exists availability   text,
  add column if not exists references_ok  boolean not null default false,
  add column if not exists verified       boolean not null default false,   -- never "committed" until true
  add column if not exists is_backup      boolean not null default false,
  add column if not exists location       text,
  add column if not exists updated_at     timestamptz not null default now();

-- ── 10) source documents (auto-downloaded + user review/selection state) ────
create table if not exists public.govcon_source_documents (
  id                   uuid primary key default gen_random_uuid(),
  owner                uuid not null,
  rfp_id               uuid not null references public.govcon_rfps(id) on delete cascade,
  original_filename    text not null,
  stored_path          text not null,               -- documents/{user}/{folder}/source_documents/…
  source_url           text,
  document_type        text,                        -- see spec category list; suggestion only
  source_category      text,                        -- source_documents | amendments | pricing | …
  amendment_number     integer,
  file_hash            text,                        -- sha-256
  file_size            bigint,
  mime_type            text,
  downloaded_at        timestamptz,
  source_last_modified timestamptz,
  extraction_status    text not null default 'pending',  -- pending | done | failed | unsupported
  extraction_error     text,
  extracted_text_path  text,                        -- …/extracted_text/{id}.txt
  user_review_status   text not null default 'Unreviewed',
  -- Unreviewed | Reviewed | Relevant | Irrelevant | Needs Follow-Up
  include_in_analysis  boolean not null default false,
  user_notes           text,
  last_analyzed_at     timestamptz,
  analysis_version     integer,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- dedupe: same file (by hash) for the same opportunity is stored once
create unique index if not exists govcon_srcdocs_hash_idx
  on public.govcon_source_documents (owner, rfp_id, file_hash) where file_hash is not null;
create index if not exists govcon_srcdocs_rfp_idx on public.govcon_source_documents (owner, rfp_id);

-- ── 11) amendments ───────────────────────────────────────────────────────────
create table if not exists public.govcon_amendments (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null,
  rfp_id           uuid not null references public.govcon_rfps(id) on delete cascade,
  amendment_number integer,
  detected_at      timestamptz not null default now(),
  summary          text,
  changes          jsonb not null default '{}',   -- {deadline:{old,new}, requirements:[…], …}
  review_required  boolean not null default true,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists govcon_amend_idx on public.govcon_amendments (owner, rfp_id, detected_at desc);

-- ── 12) award-history matches (competitive intelligence per opportunity) ────
create table if not exists public.govcon_award_matches (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null,
  rfp_id           uuid not null references public.govcon_rfps(id) on delete cascade,
  award_notice_id  text,
  awardee          text,
  amount           numeric,
  award_date       date,
  duration         text,
  agency           text,
  source_url       text,
  confidence       integer,                       -- 0-100 match confidence
  is_likely_incumbent boolean not null default false,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists govcon_awardmatch_idx on public.govcon_award_matches (owner, rfp_id);

-- ── 13) no-bid reasons (learning loop for future filtering) ──────────────────
create table if not exists public.govcon_no_bid_reasons (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null,
  rfp_id      uuid references public.govcon_rfps(id) on delete set null,
  reason      text not null,
  gates       jsonb not null default '[]',
  decided_by  text not null default 'human',      -- human | gate | score
  created_at  timestamptz not null default now()
);
create index if not exists govcon_nobid_idx on public.govcon_no_bid_reasons (owner, created_at desc);

-- ── 14) audit log (every human override, every stage change) ────────────────
create table if not exists public.govcon_audit_log (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null,
  entity      text not null,          -- rfps | analysis | requirement | submission | gate | score | pipeline
  entity_id   uuid,
  field       text,
  old_value   text,
  new_value   text,
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists govcon_audit_idx on public.govcon_audit_log (owner, entity, created_at desc);

-- ── 15) run logs (observability for every edge-function run) ────────────────
create table if not exists public.govcon_run_logs (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid,
  fn          text not null,          -- govcon-discover | govcon-enrich | …
  rfp_id      uuid,
  status      text not null default 'started',   -- started | ok | error
  stats       jsonb not null default '{}',
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists govcon_runlogs_idx on public.govcon_run_logs (owner, fn, started_at desc);

-- ── RLS on every new table ───────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'govcon_opportunity_analysis','govcon_score_components','govcon_hard_gates',
    'govcon_requirements','govcon_submission_requirements','govcon_next_actions',
    'govcon_subcontractor_needs','govcon_source_documents','govcon_amendments',
    'govcon_award_matches','govcon_no_bid_reasons','govcon_audit_log','govcon_run_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_own on public.%I', t, t);
    execute format(
      'create policy %I_own on public.%I for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid())',
      t, t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array[
    'govcon_opportunity_analysis','govcon_score_components','govcon_hard_gates',
    'govcon_requirements','govcon_submission_requirements','govcon_next_actions',
    'govcon_subcontractor_needs','govcon_source_documents','govcon_amendments',
    'govcon_award_matches'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I for each row execute function public.govcon_touch_updated_at()',
      t, t);
  end loop;
end $$;

-- ── make the schema cache see everything now ─────────────────────────────────
notify pgrst, 'reload schema';
