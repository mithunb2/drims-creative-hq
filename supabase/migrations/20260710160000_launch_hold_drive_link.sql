-- ============================================================
-- Carry the delivered Drive link into launch_holds so the review surface can play it straight from
-- Supabase — no per-buyer ClickUp token needed. Written by drive_promotion_worker at promote time
-- (editor pastes the "Drive Link" field on the task → promotion copies it here → Stage 2 plays it).
-- ============================================================
alter table public.launch_holds add column if not exists drive_link text;
