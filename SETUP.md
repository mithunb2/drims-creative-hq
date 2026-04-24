# Setup — DRIMS Creative HQ from scratch

This walks you from an empty repo to a working dashboard with classifier. Total time ~30 minutes if everything clicks.

---

## Step 1 — Supabase project (~5 min)

1. Go to https://supabase.com/dashboard → **New project**
2. Name: `drims-creative-hq` • region: closest to you (Leduc → `us-west-1` or `ca-central-1`) • plan: free
3. Pick a **strong database password** — save it, you'll need it twice (for `config.js` indirectly via the DB URL, and for the local skill env)
4. Wait ~2 min for the project to provision
5. Once ready, go to **Settings → API** and copy:
   - **Project URL** — looks like `https://abcd1234.supabase.co`
   - **anon public key** — long JWT starting with `eyJ...`
   - **service_role key** — another long JWT (hidden by default, click to reveal). **This bypasses RLS — treat like a password.**

Leave the tab open — you'll run `schema.sql` here in Step 5.

---

## Step 2 — GitHub repo (~2 min)

1. Create a new **private** repo called `drims-creative-hq` on your GitHub account
2. Don't initialize with anything (no README, no .gitignore — we already have those)
3. Copy the `git remote add origin ...` command from GitHub's "push an existing repo" section

In the repo folder I shipped you:

```bash
cd drims-creative-hq
git init
git add .
git commit -m "Initial commit — DRIMS Creative HQ fork of Immuvi Command Center"
git branch -M main
git remote add origin git@github.com:<your-username>/drims-creative-hq.git
git push -u origin main
```

---

## Step 3 — Vercel deployment (~3 min)

1. Go to https://vercel.com → **Add New → Project**
2. Import the `drims-creative-hq` GitHub repo
3. Framework preset: **Other** (it's a static site, no build step)
4. Build command: leave blank • Output directory: leave blank
5. Click **Deploy** — takes ~30 seconds
6. Once deployed, copy the URL (e.g. `drims-creative-hq.vercel.app`)
7. You can add a custom domain later in Project Settings → Domains

The `api/clickup.js` serverless function gets auto-detected and deployed — no config needed.

**No Vercel env vars are required** for v1. (The Immuvi setup needed them for the pre-filled skill installer; your fork uses a local installer that prompts you instead.)

---

## Step 4 — ClickUp folder for inspiration briefs (~3 min)

1. Open ClickUp, go to your DRIMS workspace (the one you use for SOPs / playbooks)
2. Inside a space, create a new **folder** called `Inspiration Briefs` (or similar)
3. Open the folder — the URL looks like `app.clickup.com/<workspace_id>/v/f/<folder_id>/<space_id>`
4. Grab these IDs:
   - **Workspace ID** — the first number after `app.clickup.com/`
   - **Folder ID** — the number after `/f/`
   - **Space ID** — the last number in the URL (for the fallback parent payload)
5. Grab your **ClickUp API key** — avatar bottom-left → Apps → API → generate a personal token (starts with `pk_`)

---

## Step 5 — Fill config.js + run schema (~3 min)

Open `config.js` and fill in:

```js
SUPABASE_URL:                   'https://abcd1234.supabase.co',   // from Step 1
SUPABASE_ANON_KEY:              'eyJ...',                         // from Step 1
CLICKUP_WORKSPACE_ID:           '12345678',                       // from Step 4
CLICKUP_INSPIRATION_FOLDER_ID:  '87654321',                       // from Step 4
```

Commit and push:

```bash
git add config.js
git commit -m "Configure for DRIMS Supabase + ClickUp"
git push
# Vercel redeploys in ~30s
```

Then in Supabase → **SQL Editor** → paste the entire contents of `schema.sql` and run it. You should see a bunch of `CREATE TABLE` / `CREATE INDEX` / `CREATE POLICY` output with no errors. Safe to re-run if anything fails mid-way.

---

## Step 6 — Smoke test (~2 min)

1. Open your Vercel URL in a browser
2. If prompted, paste your ClickUp API key (stays in browser localStorage only)
3. Create your first product via the UI:
   - Hit **+ Product** in the header — enter name (e.g. "Pain Free Knees"), pick a slug
   - It should save and appear in the product switcher
4. Add an angle in the Angles tab, a persona in the Personas tab
5. Open DevTools → Network → confirm requests are going to your `abcd1234.supabase.co`
6. Check Supabase dashboard → Table Editor → `products` — your product should be there

If you see realtime-subscription errors, go to Supabase → Database → Replication and ensure `supabase_realtime` publication includes the tables (the `schema.sql` does this but Supabase sometimes needs a UI toggle).

---

## Step 7 — Classifier setup (optional, Mac-only, ~10 min)

Only needed if you want to run the `/classify-inspiration` or `/clickup-creative-pipeline` Claude Code skills on your Mac.

```bash
cd drims-creative-hq
bash skills/install-skill.sh
```

The installer will:
1. Check for Homebrew + Python 3
2. Prompt you for Supabase + ClickUp credentials (the same ones you used above)
3. Install ffmpeg, yt-dlp, Playwright Chromium, and Python deps (~200 MB)
4. Copy skill files into `~/.claude/skills/`
5. Write env to `~/.drims-classify.env` (chmod 600)
6. Smoke-test the Supabase connection

Afterwards, in any terminal, type `claude` and then `/classify-inspiration` to run the skill. It'll pick up URLs you queued from the dashboard's Inspiration tab and write results back to Supabase.

**Updating the skill** later:

```bash
cd drims-creative-hq
git pull origin main
bash skills/install-skill.sh       # re-copies the skill files, leaves env alone
```

No silent auto-update — that's intentional. Skill changes go through git.

---

## Troubleshooting

**"Missing SUPABASE_URL" in browser console** — you forgot to fill in `config.js` and push, or Vercel is still serving the old deploy. Hard-refresh.

**"new row violates row-level security policy"** — the `schema.sql` includes permissive policies for the `anon` role. If you re-ran a partial version, paste the whole file again (it's idempotent).

**ClickUp proxy returning 401 from `/api/clickup`** — your ClickUp API key is missing or wrong. Clear localStorage key `drims_api_key` and paste it again.

**Realtime updates not showing across two browser tabs** — check Supabase Database → Replication. Tables `ads`, `angles`, `personas`, `matrix_cells`, `inspirations`, `inspiration_queue`, `inspiration_results`, `manual_actions` all need to be in `supabase_realtime` publication.

**Classifier can't connect to Supabase** — check `~/.drims-classify.env` exists and has the right values. Re-run with `bash skills/install-skill.sh --reset-env` to overwrite.
