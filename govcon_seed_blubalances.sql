-- ═══════════════════════════════════════════════════════════════════════════
-- Blu Balances / Neat Necessary Cleaning LLC — company profile seed
--
-- Run AFTER govcon_migration_9.sql, in project rfdvogakvyodixgpvqvz.
-- Updates YOUR profile row (assumes you are the only user; if there are
-- several, replace the where-clause with your auth user id).
--
-- Contains ONLY facts supplied by the owner. UEI/CAGE/SAM registration are
-- deliberately left null/false — the system must treat them as "not yet
-- obtained" and gate accordingly. Never add credentials here that the
-- company does not actually hold.
-- ═══════════════════════════════════════════════════════════════════════════

update public.govcon_profiles set
  dba            = 'Blu Balances',
  legal_name     = 'Neat Necessary Cleaning LLC',
  company_name   = coalesce(nullif(company_name,''), 'Blu Balances'),
  website        = 'blubalances.com',
  phone          = '(224) 206-3770',
  business_size  = 'Small Business',
  uei            = null,          -- not yet obtained
  cage           = null,          -- not yet obtained
  sam_registered = false,         -- registration not completed
  bonding_capacity = null,        -- no bonding claims

  primary_naics = array['561720','561730','561790','561210','484210'],

  secondary_naics = array[
    '561110','561410','561499','561990','541611','541614','541618',
    '561320','488510','493110','561740','561710','562111','562119',
    '562910','484110','492110','492210','238990'],

  search_keywords = array[
    'janitorial','custodial','cleaning services','floor care','carpet cleaning',
    'window cleaning','pressure washing','grounds maintenance','landscaping',
    'lawn maintenance','snow removal','facilities support','building maintenance',
    'move services','office relocation','furniture moving','furniture installation',
    'debris removal','waste collection','courier','delivery services',
    'warehouse support','logistics support','administrative support',
    'project coordination','program support','document preparation',
    'records management','data entry','mailroom','help desk coordination',
    'scheduling support','staffing support'],

  excluded_terms = array[
    'armed security','professional engineer','architectural license','medical license',
    'legal representation','CPA attest','hazardous waste','classified','top secret',
    'secret clearance','facility clearance','manufacturer authorization','OEM certification'],

  certifications_detail = '[
    {"name":"Google Project Management Certificate","issuer":"Coursera","supporting":false},
    {"name":"Intuit QuickBooks Online Level 1 ProAdvisor","issuer":"Intuit","supporting":true}
  ]'::jsonb,

  capabilities = 'Project management support; administrative support; business process '
    || 'documentation and SOP development; business systems implementation; AI-assisted '
    || 'workflow automation; SaaS implementation support; document workflow and electronic '
    || 'signature solutions; team, vendor, and subcontractor coordination; facilities and '
    || 'field-service contract coordination. Tools: Jira, Microsoft 365, Excel, QuickBooks '
    || 'Online, cloud software, workflow automation, electronic document signing, scheduling, '
    || 'hiring, onboarding. One year of operational leadership managing a service team of up '
    || 'to five people. QuickBooks certification is a supporting credential — bookkeeping is '
    || 'NOT a primary service line. No federal past performance, no contract vehicles, no '
    || 'claimed socioeconomic set-asides, no security clearances, no ISO certifications.',

  past_performance = '[]'::jsonb,   -- none yet — the AI must never invent any

  deadline_gate_days = '{"rfi":2,"simplified":4,"rfq":7,"rfp":14,"complex_rfp":21}'::jsonb
where true;   -- single-user project; replace with: where user_id = '<your-auth-uid>'

-- default the Autopilot to Mode 2 with manual document selection + human approval
update public.govcon_autopilot_settings set autopilot_mode = 'mode2_manual' where true;

notify pgrst, 'reload schema';
