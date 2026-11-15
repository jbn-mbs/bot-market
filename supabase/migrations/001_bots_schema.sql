-- JBN Ops bots: Phase 0 + Phase 1 tables (design doc §6).
-- Lives in its own schema so the bots never touch raw MBS student tables.
-- After applying: Supabase dashboard → Settings → API → Exposed schemas → add "bots".

create schema if not exists bots;

-- People the bots know about. Telegram identity is linked separately (tg_users).
create table if not exists bots.people (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  role           text not null check (role in
                   ('member','reviewer','dev','founder','institution_admin','account_manager','counsellor','admin')),
  institution_id uuid,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create table if not exists bots.tg_users (
  telegram_id bigint primary key,
  person_id   uuid not null unique references bots.people(id) on delete cascade,
  chat_id     bigint not null,          -- private chat id (equals telegram_id for DMs)
  username    text,
  linked_at   timestamptz not null default now(),
  active      boolean not null default true
);

create table if not exists bots.link_codes (
  code       text primary key,
  person_id  uuid not null references bots.people(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- ---------- A · Team Tracker ----------
create table if not exists bots.projects (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  start_date        date not null,
  deadline          date not null,
  -- [{ "key": "qfile", "label": "Q-File", "target": 1 }, ...]
  deliverable_types jsonb not null,
  min_pick_quals    int not null default 36,  -- sector pick must cover at least this many qualifications
  max_sectors       int not null default 4,
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);
create unique index if not exists projects_one_active on bots.projects (active) where active;

create table if not exists bots.items (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references bots.projects(id) on delete cascade,
  sector     text not null,
  title      text not null,
  owner_id   uuid references bots.people(id) on delete set null
);
create index if not exists items_project_sector on bots.items (project_id, sector);
create index if not exists items_owner on bots.items (owner_id);

create table if not exists bots.sector_picks (
  project_id          uuid not null references bots.projects(id) on delete cascade,
  person_id           uuid not null references bots.people(id) on delete cascade,
  sector              text not null,
  qualification_count int not null,
  picked_at           timestamptz not null default now(),
  primary key (project_id, sector)          -- one owner per sector
);

create table if not exists bots.submissions (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references bots.items(id) on delete cascade,
  deliverable text not null,
  by_person   uuid not null references bots.people(id),
  qty         int not null default 1 check (qty > 0),
  file_url    text,
  partial     boolean not null default false,
  at          timestamptz not null default now()
);
create index if not exists submissions_item on bots.submissions (item_id);
create index if not exists submissions_at on bots.submissions (at);

-- ---------- B · Dev & Release Monitor ----------
create table if not exists bots.checks (
  target          text primary key,       -- e.g. "api:health", "smoke:user1"
  kind            text not null,          -- health | smoke | seed
  last_status     text not null default 'unknown',  -- ok | fail | unknown
  last_checked_at timestamptz,
  last_latency_ms int,
  last_detail     text
);

create table if not exists bots.incidents (
  id          uuid primary key default gen_random_uuid(),
  target      text not null,
  kind        text not null,
  detail      text,
  opened_at   timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists incidents_open on bots.incidents (target) where resolved_at is null;

create table if not exists bots.deploys (
  id             text primary key,        -- Vercel deployment id
  project        text,
  target         text,                    -- production | preview
  state          text not null,           -- started | ready | failed | canceled
  url            text,
  branch         text,
  commit_message text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists bots.uat_runs (
  id          uuid primary key default gen_random_uuid(),
  suite       text not null,
  pass        int not null,
  fail        int not null,
  blocked     int not null,
  run_date    date not null default current_date,
  recorded_by uuid references bots.people(id),
  at          timestamptz not null default now()
);

create table if not exists bots.bug_reports (
  id          uuid primary key default gen_random_uuid(),
  github_number int,
  url         text,
  severity    text not null check (severity in ('P0','P1','P2','P3')),
  title       text not null,
  state       text not null default 'open',
  reported_by uuid references bots.people(id),
  at          timestamptz not null default now()
);

-- ---------- Shared ----------
-- grammY conversation state (serverless functions keep no memory between updates)
create table if not exists bots.sessions (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists bots.jobs (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,
  payload    jsonb not null default '{}',
  state      text not null default 'queued',  -- queued | running | done | failed
  attempts   int not null default 0,
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bots.audit_log (
  id     bigserial primary key,
  actor  text not null,      -- person id, "system" or "cron:<job>"
  action text not null,
  target text,
  detail jsonb,
  at     timestamptz not null default now()
);

-- Only the service role (used by the bot backend) can read or write. No anon/authenticated policies.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'bots' loop
    execute format('alter table bots.%I enable row level security', t);
  end loop;
end $$;

grant usage on schema bots to service_role;
grant all on all tables in schema bots to service_role;
grant all on all sequences in schema bots to service_role;

-- Private bucket for submission files and bug screenshots (accessed via service role / signed URLs only).
insert into storage.buckets (id, name, public) values ('bot-files', 'bot-files', false)
on conflict (id) do nothing;
