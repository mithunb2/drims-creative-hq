-- Role on the team roster, sourced from team.json's `kind` (video_editor | media_buyer | owner |
-- manager | designer_images | …). The unified Team tab filters the roster on role ∈
-- {video_editor, media_buyer} — replacing the hardcoded CAPACITY_EXCLUDE_IDS id-list in config.js.
alter table public.team_status add column if not exists role text;
