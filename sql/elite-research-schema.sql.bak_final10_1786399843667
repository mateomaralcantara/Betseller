-- sql/elite-research-schema.sql
-- Capa Elite para investigación real, fuentes, hechos y quality gate.

create table if not exists public.research_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text,
  url text,
  author text,
  publisher text,
  source_type text,
  published_at timestamptz,
  extracted_text text,
  summary text,
  reliability_score numeric check (reliability_score is null or (reliability_score >= 1 and reliability_score <= 10)),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.research_facts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  claim text not null,
  status text not null default 'UNVERIFIED' check (
    status in ('VERIFIED', 'PARTIALLY_VERIFIED', 'DISPUTED', 'UNVERIFIED', 'REJECTED')
  ),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_ids uuid[] not null default '{}',
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.chapter_quality_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  chapter_number integer not null,
  score numeric not null check (score >= 1 and score <= 10),
  status text not null default 'PENDING_REVIEW',
  factual_risks jsonb not null default '[]'::jsonb,
  unsupported_claims jsonb not null default '[]'::jsonb,
  rewrite_instructions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_research_sources_project_id
on public.research_sources(project_id);

create index if not exists idx_research_facts_project_id
on public.research_facts(project_id);

create index if not exists idx_chapter_quality_project_chapter
on public.chapter_quality_reports(project_id, chapter_number);

alter table public.research_sources enable row level security;
alter table public.research_facts enable row level security;
alter table public.chapter_quality_reports enable row level security;

drop policy if exists "research_sources_select_own" on public.research_sources;
create policy "research_sources_select_own"
on public.research_sources
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = research_sources.project_id
      and p.user_id = auth.uid()
  )
);

drop policy if exists "research_facts_select_own" on public.research_facts;
create policy "research_facts_select_own"
on public.research_facts
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = research_facts.project_id
      and p.user_id = auth.uid()
  )
);

drop policy if exists "chapter_quality_reports_select_own" on public.chapter_quality_reports;
create policy "chapter_quality_reports_select_own"
on public.chapter_quality_reports
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = chapter_quality_reports.project_id
      and p.user_id = auth.uid()
  )
);
