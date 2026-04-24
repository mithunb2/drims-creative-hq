-- DRIMS Creative HQ — Supabase schema
-- Idempotent: safe to re-run. Drops nothing.
-- Run via Supabase SQL Editor OR `supabase db push` after linking the project.

-- ============================================================
-- EXTENSIONS
-- ============================================================
create extension if not exists "uuid-ossp";

-- ============================================================
-- PRODUCTS
-- ============================================================
create table if not exists public.products (
  id text primary key,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- ANGLES
-- ============================================================
create table if not exists public.angles (
  id text primary key,
  product_id text not null references public.products(id) on delete cascade,
  name text not null,
  status text not null default 'Untested',
  source_link text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_angles_product on public.angles(product_id);

-- ============================================================
-- PERSONAS
-- ============================================================
create table if not exists public.personas (
  id text primary key,
  product_id text not null references public.products(id) on delete cascade,
  name text not null,
  status text not null default 'Untested',
  source_link text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_personas_product on public.personas(product_id);

-- ============================================================
-- ANGLE × PERSONA matrix links
-- ============================================================
create table if not exists public.angle_personas (
  id uuid primary key default uuid_generate_v4(),
  product_id text not null references public.products(id) on delete cascade,
  angle_id text not null references public.angles(id) on delete cascade,
  persona_id text not null references public.personas(id) on delete cascade,
  linked boolean not null default true,
  created_at timestamptz not null default now(),
  unique (product_id, angle_id, persona_id)
);
create index if not exists idx_ap_product on public.angle_personas(product_id);

-- ============================================================
-- ADS
-- ============================================================
create table if not exists public.ads (
  id text primary key,
  product_id text not null references public.products(id) on delete cascade,
  format_name text,
  ad_link text,
  drive_link text,
  ad_type text,
  funnel_stage text,
  status text not null default 'Untested',
  angle text,
  persona text,
  parent_ad_id text,
  variation_number int,
  ad_origin text,
  clickup_task_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ads_product on public.ads(product_id);
create index if not exists idx_ads_status on public.ads(product_id, status);
create index if not exists idx_ads_parent on public.ads(parent_ad_id);

-- ============================================================
-- MATRIX CELLS (replaces MATRIX_CELL_META + CELL_CREATIVE_ASSIGNMENTS)
-- ============================================================
create table if not exists public.matrix_cells (
  id uuid primary key default uuid_generate_v4(),
  product_id text not null references public.products(id) on delete cascade,
  angle_id text not null,
  persona_id text not null,
  meta jsonb not null default '{}'::jsonb,
  creative_assignments jsonb not null default '[]'::jsonb,
  action_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, angle_id, persona_id)
);
create index if not exists idx_mc_product on public.matrix_cells(product_id);

-- ============================================================
-- MANUAL ACTIONS (free-form action log per product)
-- ============================================================
create table if not exists public.manual_actions (
  id uuid primary key default uuid_generate_v4(),
  product_id text not null references public.products(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  live_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ma_product on public.manual_actions(product_id);

-- ============================================================
-- INSPIRATIONS (saved competitor ad URLs, not yet classified)
-- ============================================================
create table if not exists public.inspirations (
  id text primary key,                   -- INS-XXX
  product_id text not null references public.products(id) on delete cascade,
  url text not null,
  title text,
  platform text,
  added_by text,                         -- freeform for v1, becomes user_id with auth
  status text not null default 'saved',  -- saved / queued / classified
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ins_product on public.inspirations(product_id);

-- ============================================================
-- INSPIRATION QUEUE (replaces bridge /queue + /tmp/*_pending.json)
-- ============================================================
create table if not exists public.inspiration_queue (
  id uuid primary key default uuid_generate_v4(),
  ins_id text not null,
  product_id text not null references public.products(id) on delete cascade,
  url text not null,
  platform text,
  status text not null default 'pending', -- pending / processing / done / error
  error_message text,
  queued_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (ins_id, product_id)
);
create index if not exists idx_queue_status on public.inspiration_queue(status);
create index if not exists idx_queue_product on public.inspiration_queue(product_id);

-- ============================================================
-- INSPIRATION RESULTS (replaces /tmp/*_classification_results.json)
-- ============================================================
create table if not exists public.inspiration_results (
  id uuid primary key default uuid_generate_v4(),
  ins_id text not null,
  product_id text not null references public.products(id) on delete cascade,
  source_url text not null,
  platform text,
  metadata jsonb not null default '{}'::jsonb,           -- brand, body_text, title, cta, etc.
  classification jsonb not null default '{}'::jsonb,      -- hook_type, creative_structure, persona, angle, etc.
  brief jsonb not null default '{}'::jsonb,               -- 7-section brief data for ClickUp doc
  clickup_doc_page_url text,
  clickup_doc_id text,
  duration_seconds numeric,
  frames_extracted int,
  classified_at timestamptz not null default now(),
  unique (ins_id, product_id)
);
create index if not exists idx_results_product on public.inspiration_results(product_id);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Attach trigger to tables that have updated_at
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'products','angles','personas','ads','matrix_cells','manual_actions','inspirations'
    ])
  loop
    execute format('drop trigger if exists trg_%I_updated on public.%I', t, t);
    execute format('create trigger trg_%I_updated before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- Note: angle/persona rename cascade is handled CLIENT-SIDE in the dashboard
-- (updateAngleName / updatePersonaName + renameAngleInMatrixKeys). A server
-- trigger was considered but removed — it fought the client's delete-orphans
-- step, causing row-id churn. The client is the source of truth.

-- ============================================================
-- REALTIME PUBLICATION (so teammates see each other's changes live)
-- ============================================================
do $$
declare t text;
begin
  for t in select unnest(array[
    'ads','angles','personas','matrix_cells','inspirations',
    'inspiration_queue','inspiration_results','manual_actions'
  ]) loop
    -- Try to add; ignore if already in the publication
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ============================================================
-- ROW LEVEL SECURITY (v1: open for anon, RLS on so we can tighten later)
-- ============================================================
alter table public.products            enable row level security;
alter table public.angles              enable row level security;
alter table public.personas            enable row level security;
alter table public.angle_personas      enable row level security;
alter table public.ads                 enable row level security;
alter table public.matrix_cells        enable row level security;
alter table public.manual_actions      enable row level security;
alter table public.inspirations        enable row level security;
alter table public.inspiration_queue   enable row level security;
alter table public.inspiration_results enable row level security;

-- v1 policies: allow anon to do everything (behavior identical to pre-migration).
-- When auth is added, drop these and replace with auth.uid()-based policies.
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'products','angles','personas','angle_personas','ads','matrix_cells',
      'manual_actions','inspirations','inspiration_queue','inspiration_results'
    ])
  loop
    execute format('drop policy if exists %I_anon_all on public.%I', t, t);
    execute format(
      'create policy %I_anon_all on public.%I for all to anon using (true) with check (true)',
      t, t
    );
  end loop;
end $$;

-- ============================================================
-- SEED: products
-- ============================================================
-- Intentionally empty for this fork. Add products via the dashboard UI
-- (+ Product button in the header). Each DRIMS store = one product row.
--
-- Example shape if you want to seed via SQL instead:
-- insert into public.products (id, name, config) values
--   ('pain-free-knees', 'Pain Free Knees', '{"doc_id":""}'::jsonb)
-- on conflict (id) do nothing;

-- Done.
