---
name: classify-inspiration
description: Classify competitor ad URLs for DRIMS Creative HQ. Reads pending items from the Supabase `inspiration_queue` table, downloads video/frames, classifies using Claude vision, creates ClickUp doc pages with 7-section creative briefs, writes results to Supabase `inspiration_results`.
---

# Classify Inspiration Skill (Supabase-native)

This skill reads the queue and writes results directly to Supabase — no more local bridge, no `/tmp` JSON files. Anyone on the team can queue a URL from the live dashboard; you (running Claude locally with ffmpeg) classify; results stream back to the team's browser in real time.

## Prerequisites (installed by `install-skill.sh`)

- **System:** `ffmpeg`, `yt-dlp` (`brew install ffmpeg yt-dlp`)
- **Python:** `psycopg2-binary`, `requests`, `playwright` (`pip3 install --user`) and `python3 -m playwright install chromium`
- **Env file:** `~/.drims-classify.env` with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `SUPABASE_DB_PASSWORD`
- **Bundled:** `fb_ad_classifier.py` must sit next to this `SKILL.md` in `~/.claude/skills/classify-inspiration/`

---

## Step 0 — Manual updates only (auto-update removed)

This fork does not auto-update from a remote URL. The original skill silently
downloaded new versions of `SKILL.md` and `fb_ad_classifier.py` on every run
and even had a sentinel (`SKILL_UPDATED_RELOAD_NOW`) that instructed the agent
to discard current instructions mid-run and follow the freshly-downloaded
file. That's a remote-code-execution vector for anyone with access to the
origin server, so it's gone.

To update the skill, pull from your own GitHub repo and copy the files over:

```bash
cd ~/path/to/drims-creative-hq
git pull origin main
cp skills/classify-inspiration/SKILL.md             "$HOME/.claude/skills/classify-inspiration/SKILL.md"
cp skills/classify-inspiration/fb_ad_classifier.py  "$HOME/.claude/skills/classify-inspiration/fb_ad_classifier.py"
```

---

## Env loader helper (referenced in every shell step below)

Whenever a step says `source_env` (or shows the env-loader block), it means:

```bash
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done
```

This finds the first `.env` file in the fallback chain and exports all its
non-comment variables. Installed by `install-skill.sh` into
`~/.drims-classify.env`.

---

## Connection details

All credentials live in `~/.drims-classify.env` (written by `skills/install-skill.sh`).
Never commit this file.

- **Supabase URL:** from `$SUPABASE_URL` env var
- **Service role key:** from `$SUPABASE_SERVICE_ROLE_KEY` env var (bypasses RLS)
- **Direct Postgres connection string:** from `$SUPABASE_DB_URL` env var (password from `$SUPABASE_DB_PASSWORD`)

Throughout this skill, export the env vars at the start of every shell step:

```bash
# Portable env loader — reads from ~/.drims-classify.env (set by installer).
# Fallback chain: ~/.drims-classify.env → $PWD/.env → ~/.env.
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done
```

## ClickUp constants

These must be set in your env file (same `~/.drims-classify.env`) since they're
specific to your ClickUp workspace:

- **Workspace ID:** `$CLICKUP_WORKSPACE_ID` — from the ClickUp URL (`app.clickup.com/<id>/...`)
- **Inspiration Library folder ID:** `$CLICKUP_INSPIRATION_FOLDER_ID` — create a folder in your workspace and grab its ID. **ALL product inspiration-library docs created by this skill MUST be parented here** so you have one clean folder view.
- **Parent payload for `clickup_create_document`:** `{"id": "$CLICKUP_INSPIRATION_FOLDER_ID", "type": "5"}` — type 5 = folder.
- **Naming convention for new product libs:** `"[PRODUCT_NAME_UPPERCASE] — Inspiration Library"`
- **Default page created by `clickup_create_document` with `create_page=true`:** starts unnamed. Always rename it to `"📋 Master Tracker"` and seed it with the empty-tracker template (see Step 6.5) before creating any inspiration pages.

---


## Step 1 — Pull the queue from Supabase

```bash
# Portable env loader — reads from ~/.drims-classify.env (set by installer).
# Fallback chain: ~/.drims-classify.env → $PWD/.env → ~/.env.
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done

# Get pending items — all of them, across products. Each row has product_id, ins_id, url, platform.
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$SUPABASE_DB_URL" -At -F$'\t' -c "
  select q.ins_id, q.product_id, q.url, q.platform, p.name as product_name, p.config->>'doc_id' as doc_id
  from public.inspiration_queue q
  join public.products p on p.id = q.product_id
  where q.status = 'pending'
  order by q.queued_at asc
" 2>/dev/null
```

Parse the TSV: each line is `ins_id\tproduct_id\turl\tplatform\tproduct_name\tdoc_id`.

**Exclude items already classified** — skip any queue row whose `ins_id` + `product_id` combo already exists in `inspiration_results`:

```bash
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$SUPABASE_DB_URL" -At -F$'\t' -c "
  select ins_id, product_id from public.inspiration_results
"
```

Remove from the work list any items whose `(ins_id, product_id)` appears in the results set.

**Load the product's angles and personas** so you can classify with context:

```bash
# For the product_id(s) being processed, fetch angle + persona name lists
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$SUPABASE_DB_URL" -At -c "
  select string_agg(name, ', ') from public.angles where product_id = '<PRODUCT_ID>'
"
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$SUPABASE_DB_URL" -At -c "
  select string_agg(name, ', ') from public.personas where product_id = '<PRODUCT_ID>'
"
```

**Print status and stop early if nothing to do:**
- Empty queue → tell user "No pending items in inspiration_queue. Queue some URLs from the dashboard." Stop.
- All items already classified → "All queued items already processed. Nothing new to do." Stop.
- Otherwise → print the N items to be processed with their IDs + truncated URLs.

**Mark items as `processing`** so the dashboard can show progress:

```bash
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$SUPABASE_DB_URL" -c "
  update public.inspiration_queue
  set status = 'processing'
  where ins_id in (<comma-separated-quoted-list>) and status = 'pending'
"
```

---

## Step 2 — Dispatch parallel agents (one per item)

**1 item** → process inline (Steps 3–4 directly).

**2+ items** → spawn one agent per item in parallel using the Agent tool. Each agent handles Steps 3–4 (classification + frames + result write). Paste this self-contained prompt per agent, filling in real values:

```
You are classifying a single competitor ad creative.

YOUR ITEM:
- INS_ID:     [INS-XXX]
- PRODUCT_ID: [prod-XXX]
- URL:        [url]
- Platform:   [facebook/instagram/tiktok/etc]

CONTEXT:
- Angles:   [comma-separated list or "none provided"]
- Personas: [comma-separated list or "none provided"]

ENVIRONMENT:
Before running shell commands, export env:
  # Portable env loader — reads from ~/.drims-classify.env (set by installer).
# Fallback chain: ~/.drims-classify.env → $PWD/.env → ~/.env.
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done

TASK:
1. Save the pipeline script (see below) to /tmp/ins_pipeline_[INS_ID].py
2. Run it: python3 /tmp/ins_pipeline_[INS_ID].py "[URL]" "/tmp/ins_work_[INS_ID]"
3. Read each produced frame with the Read tool (up to 6 frames)
4. Classify using the dimensions in Step 4
5. Insert the classification into Supabase `public.inspiration_results` via psql
6. Update the matching `public.inspiration_queue` row: status='done', processed_at=now()
7. Clean up: rm -rf /tmp/ins_work_[INS_ID] /tmp/ins_pipeline_[INS_ID].py
8. Print: "DONE [INS_ID]: [hook_type] | [creative_structure] | [funnel_type]"

[paste full pipeline script from Step 3]
[paste classification dimensions from Step 4]
[paste result-write SQL from Step 5]
```

Wait for ALL agents to complete before moving to Step 6 (doc page creation).

---

## Step 3 — Pipeline script (unchanged from bridge version)

Same Python script as before — downloads the video/image, extracts frames, returns metadata. Save to `/tmp/ins_pipeline_[INS_ID].py`:

```python
import asyncio, json, os, re, shutil, subprocess, sys, urllib.request

_SKILL_DIR = os.path.expanduser('~/.claude/skills/classify-inspiration')
if _SKILL_DIR not in sys.path: sys.path.insert(0, _SKILL_DIR)
from fb_ad_classifier import fetch_ad_snapshot, download_video, extract_frames, extract_ad_id, decode_unicode, USER_AGENT, OUTPUT_BASE

def detect_platform(url):
    u = url.lower()
    if "facebook.com/ads/library" in u: return "facebook"
    if "instagram.com" in u: return "instagram"
    if "tiktok.com" in u: return "tiktok"
    if "youtube.com" in u or "youtu.be" in u: return "youtube"
    return "other"

def get_duration(vp):
    try:
        r = subprocess.run(["ffprobe","-v","quiet","-print_format","json","-show_streams",vp], capture_output=True, text=True, timeout=15)
        for s in json.loads(r.stdout).get("streams",[]):
            if "duration" in s: return float(s["duration"])
    except: pass
    return 0.0

def download_ytdlp(url, outdir):
    os.makedirs(outdir, exist_ok=True)
    vp = os.path.join(outdir, "video.mp4")
    subprocess.run(["yt-dlp","--quiet","-f","mp4/best[height<=720]/best","-o",vp,url], capture_output=True, timeout=90, check=True)
    return vp

url = sys.argv[1]
work_dir = sys.argv[2]
os.makedirs(work_dir, exist_ok=True)

platform = detect_platform(url)
snapshot = {}
frames = []
duration = 0.0

try:
    if platform == "facebook":
        ad_id = extract_ad_id(url)
        snapshot = asyncio.run(fetch_ad_snapshot(ad_id))
        snapshot["ad_id"] = ad_id
        video_url = snapshot.get("video_hd_url") or snapshot.get("video_sd_url")
        if video_url:
            vp = os.path.join(work_dir, "video.mp4")
            download_video(video_url, vp)
            duration = get_duration(vp)
            frames = extract_frames(vp, work_dir)
            os.remove(vp)
        elif snapshot.get("image_url"):
            ip = os.path.join(work_dir, "frame_001.jpg")
            req = urllib.request.Request(snapshot["image_url"], headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as r, open(ip,"wb") as f: f.write(r.read())
            frames = [ip]
        else:
            raise RuntimeError("No media found")
    else:
        vp = download_ytdlp(url, work_dir)
        duration = get_duration(vp)
        frames = extract_frames(vp, work_dir)
        os.remove(vp)

    result = {
        "frames": frames,
        "duration": round(duration, 1),
        "metadata": {
            "body_text": decode_unicode(snapshot.get("body_text") or ""),
            "title": decode_unicode(snapshot.get("title") or ""),
            "page_name": decode_unicode(snapshot.get("page_name") or ""),
            "cta_text": decode_unicode(snapshot.get("cta_text") or ""),
            "link_url": snapshot.get("link_url") or snapshot.get("caption") or "",
            "ad_id": snapshot.get("ad_id",""),
        },
        "error": None
    }
except Exception as e:
    result = {"frames": [], "duration": 0, "metadata": {}, "error": str(e)}

print(json.dumps(result))
```

---

## Step 4 — Visually classify the frames

Read each frame with the **Read tool** (up to 6 frames). You are a senior media buyer. Classify:

| Field | Options |
|---|---|
| photo_video | Video, Photo, Carousel, UGC, VSL, AI Style |
| hook_type | Pain/Problem, Fear, Curiosity, Social Proof, Aspirational, Direct Offer, Controversy/Bold Claim, POV, Question, News/Trend, Pattern Interrupt |
| creative_structure | UGC, Testimonial, Demo, Tutorial/How-To, Story/Narrative, Hook+Offer, Listicle, Static/Photo, Comparison, Interview, Skit/Roleplay, AI/Voiceover, Slideshow/Compilation |
| production_style | Organic/Raw UGC, Polished UGC, Professional Studio, AI Generated, Screen Record, Animation/Motion, Static Graphic, Slideshow, Repurposed Organic, Competitor Inspired |
| funnel_type | TOF, MOF, BOF |
| persona | Exact name from personas list if match ≥60%, else short label (4–6 words) |
| angle | Exact name from angles list if match ≥60%, else short label (2–5 words) |
| creative_usp | "Format Name — scroll-stopping mechanic" in 20 words |
| creative_hypothesis | 2 sentences: why made + why it works. Max 35 words. |
| notes | What you literally see. Max 30 words. |
| body_copy_from_frames | Transcribe all visible on-screen text / subtitles from the frames |
| page_name | From pipeline page_name metadata, or visually identified brand name if pipeline returned empty (Instagram/TikTok). **IMPORTANT:** dashboard reads `metadata.page_name` for the Brand column — always populate this field, even if the pipeline didn't. |
| brand | Same value as page_name (human-readable alias) |
| body_text | From body_text metadata |
| title / headline | From title metadata (dashboard reads both keys — write the same value to both) |
| cta_text | From cta_text metadata |
| landing_url / link_url | From link_url metadata (write to both keys) |
| duration_seconds | From pipeline output |

**Also build the full 7-section brief data** (same as before):

```
FRAME_BY_FRAME: timestamped breakdown with label (HOOK/TENSION/PROOF/BRIDGE/CTA) + what happens + emotion triggered
WHY_IT_WORKS: 4–5 psychological mechanisms in plain English
REPLICATION_BRIEF: talent, set, key overlay, subtitle style, pacing, music, mid-video, end card
WHAT_TO_TEST: 5 specific variation ideas (one line each: what changes + why)
COMPETITOR_INTEL: brand scale, funnel strategy, our gap, compete or find lane
OUR_NEXT_AD: what to steal, what to do differently, 3-bullet editor brief, hypothesis sentence
```

---

## Step 5 — Write result to Supabase

For each classified item, insert a row into `inspiration_results` and mark the queue row done:

```bash
# Portable env loader — reads from ~/.drims-classify.env (set by installer).
# Fallback chain: ~/.drims-classify.env → $PWD/.env → ~/.env.
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done

# Build JSON payloads (use a temp file so quoting doesn't break)
cat > /tmp/result_[INS_ID].json <<'JSON'
{
  "metadata": {
    "page_name": "...",
    "brand": "...",
    "body_text": "...",
    "title": "...",
    "headline": "...",
    "cta_text": "...",
    "landing_url": "...",
    "link_url": "...",
    "ad_id": "...",
    "body_copy_from_frames": "..."
  },
  "classification": {
    "photo_video": "...",
    "hook_type": "...",
    "creative_structure": "...",
    "production_style": "...",
    "funnel_type": "...",
    "persona": "...",
    "persona_matched": true,
    "angle": "...",
    "angle_matched": true,
    "creative_usp": "...",
    "creative_hypothesis": "...",
    "notes": "..."
  },
  "brief": {
    "frame_by_frame": [ ... ],
    "why_it_works": "...",
    "replication_brief": "...",
    "what_to_test": "...",
    "competitor_intel": "...",
    "our_next_ad": "..."
  }
}
JSON

PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 <<SQL
insert into public.inspiration_results
  (ins_id, product_id, source_url, platform, metadata, classification, brief,
   duration_seconds, frames_extracted, classified_at)
values
  ('[INS_ID]', '[PRODUCT_ID]', '[URL]', '[PLATFORM]',
   (select metadata from json_populate_record(null::record, pg_read_file('/tmp/result_[INS_ID].json')::json)),  -- easier: use jsonb literal below instead
   '...'::jsonb, '...'::jsonb,
   [duration_seconds], [frames_count], now())
on conflict (ins_id, product_id) do update
  set metadata = excluded.metadata,
      classification = excluded.classification,
      brief = excluded.brief,
      classified_at = now();
SQL
```

**Simpler recommended form** — use Python with `psycopg2` or the Supabase REST API (with the service_role key) to insert. Example via REST:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/inspiration_results" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates" \
  --data @/tmp/result_[INS_ID].json
```

Where the JSON file has the full shape:

```json
{
  "ins_id": "[INS_ID]",
  "product_id": "[PRODUCT_ID]",
  "source_url": "[URL]",
  "platform": "[PLATFORM]",
  "metadata": { ... },
  "classification": { ... },
  "brief": { ... },
  "duration_seconds": 12.5,
  "frames_extracted": 6
}
```

Then mark the queue row done:

```bash
curl -s -X PATCH "$SUPABASE_URL/rest/v1/inspiration_queue?ins_id=eq.[INS_ID]&product_id=eq.[PRODUCT_ID]" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  --data '{"status":"done","processed_at":"now()"}'
```

---

## Step 5b — Write DIRECTLY to `public.inspirations.data` (avoid poller race)

**Why:** The dashboard polls `inspiration_results` every 6 s, maps fields into `inspirations.data`, then DELETES the source row (`DB.clearResults`). If the poller tab isn't open, or a second row update arrives before the next poll, fields get lost or overwritten with defaults. Writing directly to `inspirations.data` is lossless and triggers the dashboard's realtime subscription on the `inspirations` table within 1–2 s.

The dashboard's `applyClassificationResults` function expects these **camelCase** keys inside `inspirations.data`:

| data jsonb key | Source in your classification |
|---|---|
| `brand` | metadata.page_name |
| `hookType` | classification.hook_type (normalized to UI options) |
| `creativeStructure` | classification.creative_structure |
| `productionStyle` | classification.production_style |
| `funnelStage` | classification.funnel_type |
| `adType` | classification.photo_video |
| `persona` | classification.persona |
| `angle` | classification.angle |
| `creativeUSP` | classification.creative_usp |
| `formatName` | first phrase of creative_usp before " — " |
| `creativeHypothesis` | classification.creative_hypothesis |
| `notes` | classification.notes |
| `bodyCopy` | metadata.body_copy_from_frames OR metadata.body_text |
| `headline` | metadata.title |
| `ctaText` | metadata.cta_text |
| `landingUrl` | metadata.link_url |
| `duration_seconds` | pipeline output |
| `status` | `"Classified"` literal |
| `classifiedAt` | `Date.now()` equivalent (epoch ms) |
| `_needsAngleReview` | `true` if angle_matched=false and no fuzzy match ≥60%, else `false` |
| `_needsPersonaReview` | same logic for persona |
| `_anglePromptDone` | `true` after this skill has tried to match |
| `_personaPromptDone` | `true` after this skill has tried to match |
| `_clickupDocPageUrl` | set in Step 6 after page create/update |
| `_clickupDocId` | set in Step 6 after page create/update |
| `_inspoDocCreated` | `true` after Step 6 |

Use `psycopg2` (simpler than curl with JSON escaping):

```bash
# Portable env loader — reads from ~/.drims-classify.env (set by installer).
# Fallback chain: ~/.drims-classify.env → $PWD/.env → ~/.env.
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done
python3 <<'PYEOF'
import json, os, psycopg2, time
result = json.load(open('/tmp/result_[INS_ID].json'))
md = result['metadata']
cls = result['classification']

brand = md.get('page_name') or md.get('brand') or ''
body_copy = md.get('body_copy_from_frames') or md.get('body_text') or ''
usp = cls.get('creative_usp') or ''
format_name = usp.split(' — ')[0].strip() if ' — ' in usp else usp

patch = {
  'brand': brand,
  'hookType': cls.get('hook_type') or '',
  'creativeStructure': cls.get('creative_structure') or '',
  'productionStyle': cls.get('production_style') or '',
  'funnelStage': cls.get('funnel_type') or 'TOF',
  'adType': cls.get('photo_video') or 'Video',
  'persona': cls.get('persona') or '',
  'angle': cls.get('angle') or '',
  'creativeUSP': usp,
  'formatName': format_name,
  'creativeHypothesis': cls.get('creative_hypothesis') or '',
  'notes': cls.get('notes') or '',
  'bodyCopy': body_copy,
  'headline': md.get('title') or '',
  'ctaText': md.get('cta_text') or '',
  'landingUrl': md.get('link_url') or '',
  'duration_seconds': result.get('duration_seconds') or 0,
  'status': 'Classified',
  'classifiedAt': int(time.time() * 1000),
  '_needsAngleReview': not cls.get('angle_matched', False),
  '_needsPersonaReview': not cls.get('persona_matched', False),
  '_anglePromptDone': True,
  '_personaPromptDone': True,
}

conn = psycopg2.connect(os.environ['SUPABASE_DB_URL']); cur = conn.cursor()
# Merge patch into existing data jsonb (JSONB || operator, right wins)
cur.execute("""
  update public.inspirations
  set data = coalesce(data,'{}'::jsonb) || %s::jsonb,
      status = 'Classified'
  where id = %s and product_id = %s
  returning id
""", (json.dumps(patch), '[INS_ID]', '[PRODUCT_ID]'))
print('updated:', cur.fetchone())
conn.commit(); cur.close(); conn.close()
PYEOF
```

The dashboard sees this within 1–2 s via its realtime subscription on `public.inspirations`.

---

## Step 6 — Create or UPDATE ClickUp Doc Page (7-section brief)

Uses the `doc_id` from `products.config->>'doc_id'` (pulled in Step 1). **IMPORTANT:** always list existing pages first. If a page already starts with `[INS_ID]` (same ins_id, regardless of old/stale title), UPDATE it instead of creating a duplicate.

### 6-pre — Resolve library doc (discover → create) + heal product config

**Always** run this block, even when `products.config->>'doc_id'` already looks set. The `products.config` jsonb can be clobbered by the ClickUp list-sync job (which replaces fields like `last_synced_at_ms`), so `doc_id`/`master_tracker_page_id` can silently go missing between runs. This block is idempotent: it re-verifies both IDs against ClickUp and writes them back if they're wrong, missing, or pointing at a deleted page.

Do this **once per distinct product_id in the batch**, before any 6a/6b work for that product:

```text
1. CONFIG CHECK
   • If config has both doc_id AND master_tracker_page_id → verify both still resolve:
       - GET  https://api.clickup.com/api/v3/workspaces/$CLICKUP_WORKSPACE_ID/docs/{doc_id}/pages
       - If that returns 200 AND page_id appears in the list AND its name starts with "📋 Master Tracker"
         → config is healthy, skip to 6a with these IDs.
   • Otherwise → fall through to step 2 (discover).

2. DISCOVER EXISTING LIBRARY DOC (never create if one already exists)
   • Search the Inspiration Library folder ($CLICKUP_INSPIRATION_FOLDER_ID) for an existing doc whose name matches this product:
       clickup_search({
         workspace_id: "$CLICKUP_WORKSPACE_ID",
         keywords: "[PRODUCT_NAME] Inspiration Library",
         filters: { asset_types: ["doc"], location: { categories: ["$CLICKUP_INSPIRATION_FOLDER_ID"] } }
       })
   • Accept a hit when the doc name, case-insensitively, contains both the product name AND "inspiration library". Prefer exact "[PRODUCT_NAME uppercased] — Inspiration Library".
   • If found → use its id as doc_id. Then list pages and find the one whose name is exactly "📋 Master Tracker"
     (or starts with "📋 Master Tracker" / "Master Tracker"). Use its id as master_tracker_page_id.
   • Go to step 4 (heal config).

3. CREATE (only reached when nothing was discovered)
   Call: clickup_create_document
     workspace_id: "$CLICKUP_WORKSPACE_ID"
     name: "[PRODUCT_NAME uppercased] — Inspiration Library"
     parent: {"id": "$CLICKUP_INSPIRATION_FOLDER_ID", "type": "5"}   ← Inspiration Lib folder (type 5 = folder)
     visibility: "PUBLIC"
     create_page: true

   Response → capture document_id as doc_id.

   Call: clickup_list_document_pages(document_id)
   → grab the single auto-created page's id; that becomes master_tracker_page_id.

   Call: clickup_update_document_page to rename + seed content
     document_id: <new doc_id>
     page_id: <that page id>
     name: "📋 Master Tracker"
     sub_title: "All [PRODUCT_NAME] inspirations — status, decision, quick reference"
     content_format: "text/md"
     content: empty-tracker markdown (see Step 6.5 for the seed template — use the empty state with "_empty — run the skill to populate_" row)

4. HEAL CONFIG (runs after discover OR create, not after the healthy-check path)
   Always merge the verified IDs back into products.config so future runs don't rediscover them.
```
```bash
python3 <<PYEOF
import os, psycopg2, json
conn = psycopg2.connect(os.environ['SUPABASE_DB_URL']); cur = conn.cursor()
# jsonb || merges; right-hand wins. Doesn't clobber other config keys like clickup_list_id, color, ins_prefix, etc.
cur.execute("""
  update public.products
  set config = coalesce(config,'{}'::jsonb) || %s::jsonb
  where id = %s
""", (json.dumps({'doc_id': '[RESOLVED_DOC_ID]', 'master_tracker_page_id': '[RESOLVED_TRACKER_PAGE_ID]'}), '[PRODUCT_ID]'))
conn.commit(); cur.close(); conn.close()
PYEOF
```

**Why discover before create:** without discovery, a wiped `doc_id` causes the skill to create a *second* library doc in the Inspiration Library folder — leaving the team with split briefs across two docs and broken historical brief URLs in `inspirations.data`. The Apr-2026 AT-INS-008 incident is exactly this failure mode: Art Therapy had its config cleared by a list-sync, and only the self-heal step (6.7) rescued the brief link because the page happened to already exist. Discovery prevents the duplicate entirely.

After this, proceed to 6a with the resolved `doc_id` + `master_tracker_page_id`. Any existing inspiration-library docs will be discovered on lookup; new products get a doc auto-created by the skill — zero manual setup.

⚠️ **Known MCP quirk:** parent type `"5"` (folder) currently works against folder `$CLICKUP_INSPIRATION_FOLDER_ID`. Earlier attempts against OTHER folders returned "Resource not found" — auth is per-folder. If create fails after discovery returned nothing: fall back to parent `{"id": "$CLICKUP_SPACE_ID", "type": "4"}` (space root), then tell the user to drag the new doc into the folder manually.

### 6a — List existing pages + decide create vs update

Use `clickup_list_document_pages` MCP tool with `document_id = [DOC_ID]`. Scan returned pages for one whose `name` starts with `[INS_ID] ` or equals `[INS_ID]`. If found → capture its `id` for update. If not → create new.

### 6b — Create OR update the inspiration page

**If existing page found:** call `clickup_update_document_page` with:
- `document_id`: [DOC_ID]
- `page_id`: found page id
- `name`: `[INS_ID] — [Brand] | [Angle]`
- `sub_title`: `[Platform] · [Duration]s · [Funnel] · [Hook Type] hook`
- `content_format`: `text/md`
- `content`: the full 7-section markdown (see template below)

**If no existing page:** call `clickup_create_document_page` with the same fields (use `document_id` + no `page_id`).

### 6c — 7-section page content template

The `content` field should be markdown with these 7 H2 sections — format matches existing pages in the doc for consistency:

```markdown
# [INS_ID] — [Brand] | [Angle]
* * *

## 1\. SNAPSHOT
> _Media Buyer — 30 second read_

| Field | Value |
| ---| --- |
| Brand | [metadata.page_name] |
| Platform | [Platform] |
| Duration | [duration_seconds]s |
| Funnel | [funnel_type] |
| Format | [photo_video] — [production_style] |
| Hook Type | [hook_type] |
| Angle | [angle] |
| Persona | [persona] |
| Status | Classified |
| Decision | — |
| Reference | [[source_url]]([source_url]) |

**Ad Copy:** [body_text or "(not available)"]
**Headline:** [title or "(not available)"]
**CTA:** [cta_text or "(not available)"]

**In one sentence:** [creative_hypothesis condensed to one sentence]
* * *

## 2\. CREATIVE BREAKDOWN
> _Strategist + Editor — frame by frame_

| Time | Label | What Happens | Emotion Triggered |
| ---| ---| ---| --- |
[render each frame_by_frame row as table row]

* * *

## 3\. WHY IT WORKS
> _Strategist — the psychology_

[why_it_works as bulleted list]
* * *

## 4\. REPLICATION BRIEF
> _Editor / Video Producer — exactly what to make_

[replication_brief broken into bullets: Talent, Set, Key overlay, Subtitle style, Pacing, Music, Mid-video, End card]
* * *

## 5\. WHAT TO TEST
> _Media Buyer + Strategist — variations_

[what_to_test as numbered list]
* * *

## 6\. COMPETITOR INTEL
> _Strategist + Media Buyer_

[competitor_intel as bullets: Brand scale, Funnel strategy, Our gap, Compete or find lane]
* * *

## 7\. OUR NEXT AD
> _Everyone — the actionable output_

[our_next_ad — include: What we're stealing, What we're doing differently, 3-line editor brief, Hypothesis]
```

### 6d — Write the doc page URL back to `inspirations.data`

After create/update, capture the page URL (format: `https://app.clickup.com/[workspace_id]/docs/[doc_id]/[page_id]`) and the page id. Update `inspirations.data` so the dashboard renders the 📄 Brief link:

```bash
# Portable env loader — reads from ~/.drims-classify.env (set by installer).
# Fallback chain: ~/.drims-classify.env → $PWD/.env → ~/.env.
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done
python3 <<'PYEOF'
import json, os, psycopg2
conn = psycopg2.connect(os.environ['SUPABASE_DB_URL']); cur = conn.cursor()
cur.execute("""
  update public.inspirations
  set data = coalesce(data,'{}'::jsonb) || %s::jsonb
  where id = %s and product_id = %s
""", (json.dumps({
  '_clickupDocPageUrl': '[PAGE_URL]',
  '_clickupDocId':      '[PAGE_ID]',
  '_inspoDocCreated':   True,
}), '[INS_ID]', '[PRODUCT_ID]'))
conn.commit(); cur.close(); conn.close()
PYEOF
```

---

## Step 6.5 — Rebuild the Master Tracker page

Product config stores `master_tracker_page_id`. If absent, skip this step and tell the user to add it (same pattern as `doc_id`).

**Strategy:** regenerate the entire tracker table from Supabase on every classify — cleaner than parsing/merging existing markdown. The `inspirations` table for this product IS the source of truth.

```bash
# Portable env loader — reads from ~/.drims-classify.env (set by installer).
# Fallback chain: ~/.drims-classify.env → $PWD/.env → ~/.env.
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done
python3 <<'PYEOF' > /tmp/tracker_[PRODUCT_ID].md
import os, psycopg2, datetime
conn = psycopg2.connect(os.environ['SUPABASE_DB_URL']); cur = conn.cursor()
cur.execute("""
  select id, platform, status,
         coalesce(data->>'brand',''),
         coalesce(data->>'angle',''),
         coalesce(data->>'persona',''),
         coalesce(data->>'hookType',''),
         coalesce(data->>'funnelStage',''),
         coalesce(data->>'_clickupDocPageUrl','')
  from public.inspirations
  where product_id = %s
  order by id asc
""", ('[PRODUCT_ID]',))
rows = cur.fetchall()
today = datetime.date.today().isoformat()
print("# 📋 Master Tracker — [PRODUCT_NAME] Inspirations\n")
print(f"Last updated: {today}")
print("* * *\n")
print("| ID | Brand | Platform | Angle | Persona | Hook | Funnel | Status | Brief |")
print("| ---| ---| ---| ---| ---| ---| ---| ---| --- |")
for (ins_id, platform, status, brand, angle, persona, hook, funnel, brief_url) in rows:
    brief = f"[Open]({brief_url})" if brief_url else "—"
    print(f"| {ins_id} | {brand or '—'} | {platform or '—'} | {angle or '—'} | {persona or '—'} | {hook or '—'} | {funnel or '—'} | {status or 'Saved'} | {brief} |")
print("\n* * *\n")
print("**Status options:** `Saved` · `Testing` · `Winner` · `Loser` · `Replicated` · `Archived`")
cur.close(); conn.close()
PYEOF
```

Then write the file contents as the new page content via `clickup_update_document_page`:

- `document_id`: [DOC_ID]
- `page_id`: [MASTER_TRACKER_PAGE_ID] from products.config
- `name`: `📋 Master Tracker`
- `sub_title`: `All [PRODUCT_NAME] inspirations — status, decision, quick reference`
- `content_format`: `text/md`
- `content`: contents of `/tmp/tracker_[PRODUCT_ID].md`

---

## Step 6.7 — Self-heal wiped brief URLs (NEW — run after every batch)

**Why:** Even though we write `_clickupDocPageUrl` directly to `inspirations.data`, the dashboard's frontend `saveInspirations` historically did a full-object upsert using its in-memory copy, which could overwrite the URL with an empty string if the frontend's copy was stale (e.g. realtime event arrived after the save was queued). The dashboard code was fixed in April 2026 to server-win for server-owned keys, but older dashboard deploys may still exhibit the bug. This self-heal step makes every run idempotently repair URLs — so even if something wipes the URL between runs, the next run fixes it.

Run this at the end of every classify batch, AFTER all per-item writes and doc page creates are done:

```bash
export $(grep -v '^#' "/Users/gauravpataila/Documents/Claude/Clickup /.env" | xargs)
python3 <<'PYEOF'
import os, json, psycopg2, requests, re
conn = psycopg2.connect(os.environ['SUPABASE_DB_URL']); cur = conn.cursor()

# Find all classified rows missing a brief URL, grouped by product
cur.execute("""
  select i.product_id,
         coalesce(p.config->>'doc_id','') as doc_id,
         i.id,
         (coalesce(i.data->>'brand','') || ' | ' || coalesce(i.data->>'angle','')) as search_hint
  from public.inspirations i
  join public.products p on p.id = i.product_id
  where i.status = 'Classified'
    and coalesce(i.data->>'_clickupDocPageUrl','') = ''
    and coalesce(p.config->>'doc_id','') <> ''
""")
orphans = cur.fetchall()
print(f'[self-heal] {len(orphans)} rows missing brief URLs')

# Group by doc_id → list doc's pages once, match by ins_id prefix
from collections import defaultdict
by_doc = defaultdict(list)
for product_id, doc_id, ins_id, hint in orphans:
    by_doc[doc_id].append((product_id, ins_id, hint))

CLICKUP_TOKEN = os.environ.get('CLICKUP_API_KEY','')
WS_ID = os.environ.get('CLICKUP_WORKSPACE_ID', '')
headers = {'Authorization': CLICKUP_TOKEN}
repaired = 0

for doc_id, items in by_doc.items():
    # List all pages in this doc
    r = requests.get(f'https://api.clickup.com/api/v3/workspaces/{WS_ID}/docs/{doc_id}/pages',
                     headers=headers, timeout=30)
    if r.status_code != 200:
        print(f'  [self-heal] could not list pages for doc {doc_id}: {r.status_code}')
        continue
    pages = r.json() if isinstance(r.json(), list) else r.json().get('pages', [])
    # Build ins_id → page_id lookup from page names (they start with "INS-XXX" or "[INS-XXX]")
    page_by_ins = {}
    for p in pages:
        name = p.get('name','') or ''
        m = re.match(r'^\[?([A-Z0-9-]+)[\]\s]', name)
        if m: page_by_ins[m.group(1)] = p.get('id')

    for product_id, ins_id, hint in items:
        page_id = page_by_ins.get(ins_id)
        if not page_id: continue
        url = f'https://app.clickup.com/{WS_ID}/docs/{doc_id}/{page_id}'
        cur.execute("""
          update public.inspirations
          set data = coalesce(data,'{}'::jsonb) || %s::jsonb
          where id = %s and product_id = %s
        """, (json.dumps({
          '_clickupDocPageUrl': url,
          '_clickupDocId': page_id,
          '_inspoDocCreated': True,
        }), ins_id, product_id))
        repaired += 1
        print(f'  [self-heal] repaired {ins_id} -> {url}')

conn.commit(); cur.close(); conn.close()
print(f'[self-heal] done: repaired {repaired} row(s)')
PYEOF
```

This step is cheap (one ClickUp API call per doc, one UPDATE per orphan row) and guarantees that by the time Step 8 prints the summary, no classified inspiration is missing its brief link in the dashboard.

---

## Step 7 — Clean up

```bash
rm -rf /tmp/ins_work_* /tmp/ins_pipeline_*.py /tmp/result_*.json /tmp/tracker_*.md
```

No more bridge cleanup — there is no bridge.

---

## Step 8 — Print summary

```
✅ Classified N inspiration(s) across K products

 INS_ID   | Product              | Platform | Brand     | Hook         | Funnel | Doc   | Status
----------|----------------------|----------|-----------|--------------|--------|-------|--------
 INS-003  | ASTRO REKHA          | Instagram| AstroTalk | Aspirational | TOF    | ✓     | ✓ done
 INS-004  | Pain Free Knees      | Facebook | Brand XYZ | Curiosity    | TOF    | ✗     | ✓ done
 INS-005  | KIDS LIFE SKILL      | TikTok   | —         | —            | —      | —     | ✗ error
```

Tell the user: "Done. The dashboard auto-updates via Supabase realtime — check the Vercel URL, rows will have filled in and each classified inspo has a 📄 Brief link to its ClickUp doc page."

---

## Error handling

- **Supabase connection fails**: print the error, stop, tell the user to check `.env` and internet connectivity.
- **Queue empty**: print "No pending items in inspiration_queue. Queue some URLs from the dashboard." Stop.
- **Product has empty `doc_id`**: Step 6-pre now auto-discovers an existing library doc in folder `$CLICKUP_INSPIRATION_FOLDER_ID` by name match, and only creates a new one if none is found. It also heals `products.config` on every run so a clobbered config self-repairs. If both discovery and creation fail, skip doc creation for that product, still write the classification result, and tell the user to check that the Inspiration Library folder is reachable via the ClickUp MCP.
- **Doc page creation fails**: still save the classification result. Just leave `clickup_doc_page_url` empty.
- **Facebook ad not found / yt-dlp fails / no frames**: update queue row with `status='error'` and `error_message='<message>'`; do NOT write a result row; continue with other items.
- **Prerequisites missing**: `brew install ffmpeg` · `pip3 install psycopg2-binary requests playwright` · `python3 -m playwright install chromium`

---

## Migration notes

- The bridge at `localhost:5002` is deprecated. If you find references to `INS_BRIDGE`, `/tmp/*_pending.json`, or `/tmp/*_classification_results.json` anywhere, they can be removed.
- The dashboard at `https://<your-vercel-url>` reads/writes Supabase directly. Teammates can queue URLs; only Gaurav (on this Mac) runs the classifier due to ffmpeg/yt-dlp/Playwright requirements.
