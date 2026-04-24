# Notes on the fork from Immuvi Command Center

Forked from `https://github.com/meowliker/immuvi-command-center.git` on 2026-04-24.

## Security-motivated changes

**Silent skill auto-update removed.** Both `classify-inspiration/SKILL.md` and `clickup-creative-pipeline/SKILL.md` had a "Step 0" that `curl`-downloaded fresh copies of themselves from `immuvi-command-center.vercel.app/team-skill/` on every run, and one had a `SKILL_UPDATED_RELOAD_NOW` sentinel that instructed the agent to stop following its current instructions and follow the freshly-downloaded file mid-run. Both are removed. Skill updates now go through git.

**Vercel `api/install-skill.js` endpoint removed.** The original served a pre-filled installer script that embedded the Supabase service role key for teammate onboarding, gated by `INSTALL_SKILL_SECRET`. For a solo setup (Mithun only) the local `skills/install-skill.sh` is cleaner — transparent about what's installed, prompts for credentials interactively, nothing sensitive in the Vercel deployment.

## Rebranding

- `immuvi-command-center.html` → `drims-creative-hq.html`
- `Immuvi Command Center` → `DRIMS Creative HQ` (title, header, comments)
- `Kids Mental Health Creative Ops` → `DRIMS Creative Ops`
- 22 localStorage keys: `immuvi_*` → `drims_*`
- Env file: `~/.classify-inspiration.env` → `~/.drims-classify.env`

## Hardcoded values parameterised

| Was | Became |
|---|---|
| `SB_URL = 'https://hdniumnkprkadlrrataz.supabase.co'` | `window.DRIMS_CONFIG.SUPABASE_URL` (from `config.js`) |
| `SB_ANON = 'eyJ...'` (Immuvi anon JWT) | `window.DRIMS_CONFIG.SUPABASE_ANON_KEY` |
| ClickUp workspace `9016762494` | `window.DRIMS_CONFIG.CLICKUP_WORKSPACE_ID` + `$CLICKUP_WORKSPACE_ID` env |
| Inspiration folder `90169348848` | `window.DRIMS_CONFIG.CLICKUP_INSPIRATION_FOLDER_ID` + `$CLICKUP_INSPIRATION_FOLDER_ID` env |
| Space `90162807791` | `$CLICKUP_SPACE_ID` env |
| `WS_ID = 'hardcoded'` in skill Python | `os.environ.get('CLICKUP_WORKSPACE_ID', '')` |

## Bug fix

`useInspirationFormat(id)` in the HTML hardcoded `'Immuvi'` when marking an inspiration as reused in a product. Changed to read the active product's name at runtime — so it correctly tags with whichever product is selected (Pain Free Knees, Bible Little Learners, etc.).

## Dead-code cleanup

- `SD_ANGLES`, `SD_PERSONAS`, `SD_CREATIVES`, `SD_PROD`, `SD_FORMATS` — unused constants with Immuvi/KMH-specific competitor data. Replaced with empty arrays (zero functional impact — nothing references them, but keeping the names avoids any legacy `typeof` checks blowing up).
- `INS_DOC_URL_MAP` — a two-entry legacy migration map for two specific Immuvi inspirations. Emptied; the migration function is a no-op on an empty map.
- `clickup-creative-pipeline/SKILL.md`: Immuvi-specific list field IDs + dropdown option UUIDs (~80 lines of hardcoded UUIDs tied to ClickUp list `901613118174`) replaced with a template + fresh-discovery instruction. UUIDs are per-list in ClickUp, so reusing Immuvi's wouldn't have worked anyway.

## Files deleted

- `design-mockups/` — 40+ design exploration HTMLs, not part of the working tool.
- `immuvi-command-center-v2.html` — WIP redesign, same hardcoded Immuvi values, not production.
- `scripts/export-localstorage.js`, `scripts/seed-from-localstorage.py` — Gaurav-only migration scripts, not useful to a fresh fork.
- `MIGRATION_PLAN.md` — historical planning doc for the original Immuvi cloud migration, replaced by `SETUP.md`.

## Files added

- `config.js` — runtime config. Fill in Supabase URL, anon key, ClickUp IDs, app name, storage prefix.
- `SETUP.md` — step-by-step first-time provisioning playbook.
- `NOTES-FORK.md` — this file.

## What wasn't changed

- `schema.sql` and `supabase/migrations/20260418122155_init.sql` — schema is generic, no Immuvi-specific data.
- `docs/DESIGN.md` — design system notes, visual-only, useful as-is.
- `api/clickup.js` — generic proxy, no branding changes needed.
- `skills/classify-inspiration/fb_ad_classifier.py` — Facebook Ads Library scraper + ffmpeg frame extractor, no branding.
- Most of both `SKILL.md` files outside of the sections noted above — the actual classification logic, prompts, and dimension definitions are generic.

## Re-integration path (if you ever want to merge upstream changes)

Since this is a cleanly-rebranded fork, upstream Immuvi changes are mergeable but require manual conflict resolution on:
- `config.js` reads (you'd reject their hardcoded Supabase values)
- The stripped Step 0 auto-update blocks (re-strip them each time)
- The KMH hardcoded UUIDs in `clickup-creative-pipeline/SKILL.md`
- Branding strings (title, header, localStorage prefix)

Safer default: pull the specific feature or bug fix you want as a patch, rather than rebasing.
