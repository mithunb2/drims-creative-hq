-- Live employment signal on the roster. Sourced from the Jibble People API per-member status:
-- active = (status = 'Joined' AND removedAt IS NULL). A departure (marked Removed in Jibble on
-- offboarding) flips this false on the next team_sync → the person auto-drops from the Team tab,
-- with no team.json edit. On-leave people stay (still Joined, just no recent hours).
-- FAIL-OPEN: default true — people with no Jibble account never falsely drop; only an EXPLICIT
-- Jibble removal sets active=false.
alter table public.team_status add column if not exists active boolean not null default true;
