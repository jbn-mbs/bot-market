-- Follow-up to 001: idempotent submissions, debounced alerts, private bug screenshots,
-- default grants for future tables, and removal of unused objects.

-- /done: one submission per bot message, so a double tap on a quantity button logs once.
alter table bots.submissions add column if not exists client_ref text;
create unique index if not exists submissions_client_ref on bots.submissions (client_ref) where client_ref is not null;

-- Dev monitor: count consecutive failures and track whether an incident is open,
-- so health checks need 2 failures in a row before alerting.
alter table bots.checks add column if not exists consec_fails int not null default 0;
alter table bots.checks add column if not exists alerting boolean not null default false;
update bots.checks set alerting = true, consec_fails = greatest(consec_fails, 1) where last_status = 'fail';

-- Bug screenshots live in the private bucket; the path is kept here instead of a signed URL in the issue.
alter table bots.bug_reports add column if not exists screenshot_path text;

-- Unused in Phase 0/1. Re-add in a later migration when a module needs them.
drop table if exists bots.jobs;
alter table bots.submissions drop column if exists partial;

-- Tables created later in this schema are granted to the service role automatically.
alter default privileges in schema bots grant all on tables to service_role;
alter default privileges in schema bots grant all on sequences to service_role;
