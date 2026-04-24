# DRIMS Creative HQ

Paid-ad creative ops dashboard for DRIMS ALLY — angles, personas, ad matrix, competitor-ad classification — all synced to Supabase and optionally to ClickUp.

Forked from Gaurav's Immuvi Command Center (April 2026). See `NOTES-FORK.md` for what was changed and why.

---

## What it does

- Manage **angles × personas matrix** per product (one product = one Shopify store / offer)
- Track creatives through lifecycle: Untested → Ready to Launch → Testing → Winner / Loser
- Push production-ready creatives to a ClickUp list as tasks
- Queue competitor ad URLs from the dashboard; classify them with Claude Code running locally
- Generate a 7-section creative brief per classified inspiration, stored as a ClickUp doc page

Single-page app. No auth in v1 — whoever has the URL can use it. RLS on Supabase is the one protection boundary.

---

## Repo layout

```
drims-creative-hq/
├── drims-creative-hq.html        # the dashboard (single file, ~15.7k lines)
├── config.js                     # SUPABASE_URL, anon key, ClickUp IDs (fill in!)
├── schema.sql                    # Supabase schema (re-runnable, idempotent)
├── supabase/migrations/          # same schema in Supabase CLI migration format
├── api/clickup.js                # Vercel fn — proxies browser → api.clickup.com
├── vercel.json                   # rewrites + cache headers
├── skills/
│   ├── install-skill.sh          # local installer (bash skills/install-skill.sh)
│   ├── classify-inspiration/
│   │   ├── SKILL.md              # Claude Code skill — queue → classify → Supabase
│   │   └── fb_ad_classifier.py   # Playwright + ffmpeg helpers
│   └── clickup-creative-pipeline/
│       └── SKILL.md              # Claude Code skill — classifies a ClickUp list directly
├── docs/DESIGN.md                # visual design system notes
├── .env.example                  # local env template (.env is gitignored)
├── .gitignore
└── SETUP.md                      # step-by-step first-time setup playbook
```

---

## First-time setup

Follow **`SETUP.md`** end-to-end. High level:

1. Provision **Supabase**, **GitHub**, **Vercel**, and a **ClickUp folder** (~15 min)
2. Fill in `config.js` with the four IDs/keys you just grabbed (2 min)
3. Push to GitHub → Vercel auto-deploys (1 min)
4. Run `schema.sql` in the Supabase SQL editor (1 min)
5. Open the Vercel URL, paste your ClickUp API key when prompted, start using it
6. *(Optional, Mac-only)* — run `bash skills/install-skill.sh` to install the classifier skills locally

---

## Local development

```bash
# Serve the HTML locally (doesn't use Vercel)
python3 -m http.server 8098 --bind 127.0.0.1
# → open http://localhost:8098/drims-creative-hq.html
```

The dashboard will work against your real Supabase project (since `config.js` points at it). If you want a staging env, create a second Supabase project and swap URLs in `config.js` on a branch.

---

## Deploy

Every push to `main` auto-deploys to Vercel (no build step — static HTML). Rollback is trivial: `git revert <commit> && git push`.

---

## Secrets

| Secret | Where it lives | Safe to commit? |
|---|---|---|
| Supabase anon key | `config.js` | ✅ (public by design, RLS protects data) |
| Supabase service role key | `~/.drims-classify.env` only — bypasses RLS | ❌ **never** |
| Supabase DB password | `~/.drims-classify.env` only | ❌ **never** |
| ClickUp API key | Each user's browser localStorage (they paste on first load) | ❌ (but never enters the repo) |

`.env` and `~/.drims-classify.env` are gitignored.

---

## What about authentication / multi-user?

v1 ships with no auth — the Vercel URL is shared via trust and the data inside Supabase is protected by RLS policies that allow the `anon` role to read/write. This matches the original Immuvi setup.

When it's time to add auth: flip RLS policies to require `auth.uid()`, no schema changes needed. Supabase has built-in auth and the dashboard's existing Supabase client can pick up a session cookie.

---

## The classifier — why it only runs locally

Competitor ads need to be downloaded and frame-extracted before Claude can classify them visually. That means **ffmpeg + yt-dlp + Playwright Chromium (~200 MB)** — not something you run in Vercel. So the pipeline is split:

- **Vercel** — hosts the dashboard. Anyone can queue a URL for classification.
- **Your Mac** — Claude Code runs the `classify-inspiration` skill. Picks up queued URLs from Supabase, downloads + classifies + writes results back.
- **Dashboard** — realtime-subscribes to Supabase, reflects classifier output in ~1-2s.

See `SETUP.md` → "Classifier setup (optional)" for the Mac install.
