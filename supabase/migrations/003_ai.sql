-- AI features: token usage (for the daily budget and per-person limits) and a response cache.

create table if not exists bots.llm_usage (
  id                bigserial primary key,
  day               date not null,           -- local (IST) day, matches the budget window
  purpose           text not null,           -- digest | ask
  actor             text not null,           -- person id or "system"
  model             text not null,
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  at                timestamptz not null default now()
);
create index if not exists llm_usage_day on bots.llm_usage (day, actor, purpose);

create table if not exists bots.llm_cache (
  key        text primary key,               -- sha256 of model + prompt
  value      text not null,
  created_at timestamptz not null default now()
);

alter table bots.llm_usage enable row level security;
alter table bots.llm_cache enable row level security;
grant all on bots.llm_usage, bots.llm_cache to service_role;
grant all on sequence bots.llm_usage_id_seq to service_role;
