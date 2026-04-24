---
name: clickup-creative-pipeline
description: End-to-end ClickUp creative pipeline. Fetches tasks with Drive Links, downloads creatives from Google Drive, visually classifies them (Hook Type, Creative Structure, Production Style, Funnel, Angle, Persona), generates a 7-section Creative Brief as a ClickUp Doc page, prepends a Creative Hypothesis to the description, adds a summary comment, and bulk-updates every custom field. Replaces the earlier /clickup-creative-classifier and /clickup-creative-data-fill skills (this is the superset + safer). Triggers on phrases like "run the creative pipeline on list X", "classify all tasks in this ClickUp list", "fill in the creative fields", "generate briefs for the ads in this list", "analyze all creatives in ClickUp list [ID]".
---

# ClickUp Creative Pipeline

End-to-end automated pipeline for **any ClickUp list** containing ad creatives:

1. Fetch tasks with Drive Links (skipping tasks already fully classified, unless `--force-all`)
2. Download creative assets from Google Drive
3. Extract frames and visually classify each creative
4. **Consolidation checkpoint** — if new Angles/Personas are proposed, cluster + show the user before writing to ClickUp
5. Create a full 7-section Creative Brief as a ClickUp Doc page per task
6. Update every task: description (doc link + hypothesis), comment (summary), and all custom fields

## Step 0 — Manual updates only (auto-update removed)

This fork does not auto-update from a remote URL. To update the skill, pull
from your GitHub repo and copy:

```bash
cd ~/path/to/drims-creative-hq
git pull origin main
cp skills/clickup-creative-pipeline/SKILL.md "$HOME/.claude/skills/clickup-creative-pipeline/SKILL.md"
```

---

## Env loader helper (referenced in every shell step)

Whenever a step uses Supabase credentials or a ClickUp token persisted in the env file, load them from the portable env file first:

```bash
for _p in "$HOME/.drims-classify.env" "$PWD/.env" "$HOME/.env"; do
  [ -f "$_p" ] && { set -a; source "$_p"; set +a; break; }
done
```

This matches what `/classify-inspiration` uses, so teammates who have that skill installed share the same env file. The ClickUp API key can live there as `CLICKUP_API_KEY` (or will be asked on first use).

---

## When to use

Invoke this skill when the user says things like:
- "run the creative pipeline on list X"
- "classify all tasks in this ClickUp list"
- "fill in all the custom fields for this list"
- "generate briefs for the ads in this list"
- "analyse all creatives in ClickUp list [ID]"
- "fill the creative data for new tasks in [list]" (runs the incremental path)

## Flags & modes

| Flag | Effect |
|---|---|
| *(none, default)* | **Incremental mode** — only processes tasks where Angle, Hook Type, AND Creative Structure are ALL currently empty. First run processes everything; subsequent runs auto-skip what's done. |
| `--force-all` | Re-processes every task with a Drive Link, even ones that already have classifications. Useful after a classifier-logic improvement. |
| `--task-ids A,B,C` | Processes only the named tasks. Overrides all other filters. |
| `--since YYYY-MM-DD` | Only tasks created or updated after the given date. |
| `--skip-consolidation` | Skips the new-angle/persona approval checkpoint and writes straight through. Use only when you trust the existing dropdown will absorb everything. |
| `--retry-failed` | Re-processes only tasks that failed in the prior run (read from `/tmp/<pipeline>/cu_result_<id>.json` where `success=false`). Re-fetches their current Drive URLs from ClickUp first — useful after the user re-shares Drive folders. Skips the full list re-scan. |
| `--skip-preflight` | Skips the bulk Drive-access preflight in STEP 1.5. Use only for very small runs or when you know the Drive is reliable. |

---

## STEP 0 — Gather inputs


Ask the user for (if not already provided in the message):

| Input | How to get it |
|---|---|
| **ClickUp List ID** | From URL: `app.clickup.com/…/list/XXXXXXX` — take the number after `/list/` |
| **ClickUp Doc ID** | The doc where brief pages will be created (e.g. `<your-doc-id>`) |
| **Product / Brand name** | For angle and persona context |
| **Known Angles** | Comma-separated list, or "none" |
| **Known Personas** | Comma-separated list, or "none" |
| **ClickUp API key** | Check `$CLICKUP_API_KEY` env var first (loaded by the env loader above from `~/.drims-classify.env`). If not set, ask the user and offer to persist to that env file. |
| **Workspace ID** | Found in the ClickUp URL — needed for doc page URL construction |

**Per-product defaults** (set these in a small JSON file or ask the user each run):

```
API Key:        from $CLICKUP_API_KEY (env loader)
Doc ID:         <your product's inspiration library doc ID>
Workspace ID:   $CLICKUP_WORKSPACE_ID
Known Angles:   <comma-separated list specific to this product>
Known Personas: <comma-separated list specific to this product>
```

For DRIMS products (Pain Free Knees, Bible Little Learners, Face Yoga System,
Baby Nap Made Easy, etc.), each store has its own set of angles and personas
managed in the dashboard's Angles + Personas tabs — pull them from the Supabase
`angles` and `personas` tables filtered by `product_id`.

---

## STEP 1 — Fetch all tasks + discover field IDs

### 1a. Fetch tasks
```python
import requests, json

API_KEY = "<from config or user>"
LIST_ID = "<user provided>"
HEADERS = {"Authorization": API_KEY, "Content-Type": "application/json"}
BASE = "https://api.clickup.com/api/v2"

tasks = []
page = 0
while True:
    r = requests.get(f"{BASE}/list/{LIST_ID}/task",
        headers=HEADERS,
        params={"page": page, "include_closed": "true"})
    data = r.json()
    tasks.extend(data.get("tasks", []))
    if data.get("last_page", True):
        break
    page += 1

# Extract Drive Links
work_tasks = []
for t in tasks:
    drive_url = ""
    for f in t.get("custom_fields", []):
        if f["name"] == "Drive Link":
            drive_url = f.get("value") or ""
    if drive_url:
        work_tasks.append({
            "id": t["id"], "name": t["name"],
            "status": t["status"]["status"], "drive_url": drive_url
        })

print(f"Total tasks: {len(tasks)} | With Drive Links: {len(work_tasks)}")
```

Show the user the count and confirm before proceeding.


### 1a.1 — Filter to only tasks that need classification (DEFAULT)

Unless `--force-all` / `--task-ids` / `--since` was passed, skip tasks that already look classified. A task is "already classified" when **all three** of `Angle`, `Hook Type`, and `Creative Structure` have a non-null value.

```python
def needs_classification(task, field_lookup):
    """Return True if the task has a Drive Link but is missing classification fields."""
    vals = {f["name"].lower(): f.get("value") for f in task.get("custom_fields", [])}
    # A task is "classified" when all three signal fields are filled.
    classified = all(
        vals.get(name) is not None and vals.get(name) != ""
        for name in ("angle", "hook type", "creative structure")
    )
    has_drive = any(
        vals.get(k) for k in ("drive link", "drivelink", "drive_url", "drive")
    )
    return has_drive and not classified

tasks_to_process = [t for t in all_tasks if needs_classification(t, FIELDS)]
skipped_count = len(all_tasks) - len(tasks_to_process)
print(f"{len(tasks_to_process)} tasks to classify, {skipped_count} already classified (use --force-all to include them)")
```

If `--force-all` is set, use every task with a Drive Link instead. If `--task-ids` is set, use only those IDs. If `--since` is set, filter further by `date_updated >= since` (ClickUp returns epoch ms).

### 1b. Fetch all dropdown field IDs + option UUIDs (ALWAYS do this — never hard-code for new lists)

```python
r = requests.get(f"{BASE}/list/{LIST_ID}/field", headers=HEADERS)
fields = r.json().get("fields", [])

field_ids = {}
dropdown_opts = {}

for f in fields:
    field_ids[f["name"]] = f["id"]
    print(f"  {f['name']}: {f['id']} ({f['type']})")
    if f["type"] == "drop_down":
        opts = f.get("type_config", {}).get("options", [])
        dropdown_opts[f["name"]] = {o["name"]: o["id"] for o in opts}
        for o in opts:
            print(f"    '{o['name']}': '{o['id']}'")
```

Map the discovered field names to the classification dimensions. Standard field name mappings:

| Classification field | Likely ClickUp field name |
|---|---|
| hook_type | Hook Type |
| creative_structure | Creative Structure |
| funnel_type | Funnel Type |
| photo_video | Photo/Video |
| production_style | Production Style |
| angle_tag | Angle Tag |
| persona_tag | Persona Tag |
| creative_usp | Creative USP |
| notes | Notes |

**First run per ClickUp list:** after STEP 1b discovers your list's field IDs and dropdown UUIDs above, save them to a small JSON file (e.g. `/tmp/clickup_fields_<list_id>.json`) so subsequent runs can skip discovery. UUIDs are list-specific — never reuse across lists.

Example structure (filled in from your own STEP 1b output):
```python
FIELDS = {
    "angle_tag":          "<uuid>",
    "persona_tag":        "<uuid>",
    "hook_type":          "<uuid>",
    "creative_structure": "<uuid>",
    "funnel_type":        "<uuid>",
    "photo_video":        "<uuid>",
    "production_style":   "<uuid>",
    "creative_usp":       "<uuid>",
    "notes":              "<uuid>",
}
# Populate HOOK_OPTS, STRUCT_OPTS, FUNNEL_OPTS, PV_OPTS, PROD_OPTS similarly —
# option UUIDs are per-list. The classifier picks an option name and this
# dict translates to the UUID ClickUp's API expects.
```

**For a NEW list:** Re-fetch all UUIDs fresh. Never reuse UUIDs across different ClickUp lists — they are list-specific.

---

## STEP 1.5 — Drive access pre-flight (NEW — do this BEFORE spawning agents)

**Why this exists:** historically, the pipeline didn't know a Drive folder was private until the per-task worker tried to download it 20 minutes into the run. By then, 20 agents had already been dispatched, burned compute, and returned failures. Pre-flight does a fast parallel HEAD-style check up front so the user can fix Drive sharing *before* the expensive classification stage.

**Skip this step only if** `--skip-preflight` was passed (rare — only for very small runs or known-good lists).

### 1.5a — Parallel preflight

For every task in `tasks_to_process`, in parallel (ThreadPoolExecutor(12)), attempt `gdown --folder <url>` into a throwaway tempdir and categorize:

| Category | Heuristic | Severity |
|---|---|---|
| `accessible` | gdown returns ≥1 file >5KB | OK — proceed |
| `account_scoped_ok` | URL contained `/drive/u/N/` AND download succeeded | ⚠️ warn — works today but flaky for automation |
| `empty_folder` | gdown returns 0 files, or all <5KB | ❌ folder exists but has no media |
| `html_response` | gdown downloaded HTML (sign-in page) | ❌ private — folder not publicly shared |
| `timeout` | gdown >180s | ❓ retry once with 300s; if still timeout, large folder — warn but still dispatch (the agent will timeout too but with more context) |
| `not_folder_url` | URL doesn't contain `/folders/` or `/file/d/` | ❌ malformed Drive URL |
| `no_drive_link` | task had no Drive Link value at all | ❌ skip task |

```python
def preflight(task):
    tid = task["task_id"]
    url = re.sub(r'/drive/u/\d+/', '/drive/', task["drive_url"] or "")
    is_account_scoped = '/drive/u/' in (task["drive_url"] or "")
    w = f"/tmp/<pipeline>/pf_{tid}"
    shutil.rmtree(w, ignore_errors=True); os.makedirs(w, exist_ok=True)
    if '/folders/' not in url and '/file/d/' not in url:
        return {"task_id": tid, "status": "not_folder_url"}
    try:
        subprocess.run(["python3","-m","gdown","--folder", url, "-O", w, "--quiet"],
                       capture_output=True, text=True, timeout=180, check=False)
    except subprocess.TimeoutExpired:
        return {"task_id": tid, "status": "timeout"}
    files = [f for f in glob.glob(f"{w}/**/*", recursive=True)
             if os.path.isfile(f) and os.path.getsize(f) > 5000]
    vids = [f for f in files if f.lower().endswith(('.mp4','.mov','.mkv','.webm'))]
    imgs = [f for f in files if f.lower().endswith(('.jpg','.jpeg','.png','.webp'))]
    shutil.rmtree(w, ignore_errors=True)
    if not (vids or imgs):
        return {"task_id": tid, "status": "empty_folder"}
    if is_account_scoped:
        return {"task_id": tid, "status": "account_scoped_ok",
                "vids": len(vids), "imgs": len(imgs)}
    return {"task_id": tid, "status": "accessible",
            "vids": len(vids), "imgs": len(imgs)}
```

Save the preflight result to `/tmp/<pipeline>/preflight_report.json` — the orchestrator may need it during retries.

### 1.5b — Present the preflight report to the user

Always show the counts, even if every task passed:

```
📋 Drive access pre-flight (all 140 tasks checked in parallel, ~60s)

✅ Accessible:            108 tasks — ready for classification
⚠️  Account-scoped (/u/N/): 14 tasks — works today but may break silently later
❌ Private / HTML return:  12 tasks — folders not publicly shared
❌ Empty folder:            3 tasks — no media files
❓ Timeout:                 2 tasks — large folders or network blip
❌ Malformed URL:           1 task — no /folders/ in URL
```

If any tasks are in non-OK categories, present the user with these options BEFORE dispatching agents:

```
── What should I do with the 18 problematic tasks? ──
  [p] Pause — give the user time to fix Drive sharing, then re-run preflight
  [s] Skip — proceed with only the 108 accessible + 14 account-scoped tasks
      (the 18 will be marked success=false in their result files and
       appear in the final skip-list — you can retry later with --retry-failed)
  [c] Comment — auto-post a ClickUp comment on each problematic task asking
      the Drive owner to re-share as "Anyone with the link can view", then pause
  [a] All — still dispatch agents for every task; those with bad Drive URLs
      will fail per task as before (the old behavior)
```

Default is `[s] Skip` for unattended runs. For interactive runs, pause for the user's pick.

### 1.5c — Auto-post "please re-share" comments (option [c])

When the user picks `[c]`, post this templated comment on every problematic task (the comment does NOT block the pipeline — it's a nudge to the owner). Then switch to option `[s]` and proceed with the accessible subset.

```python
COMMENT_TEMPLATE = (
    "🚫 Automated classification could not access this Drive folder.\n\n"
    "**Reason:** {reason}\n\n"
    "**Fix:** open the folder in Google Drive → Share → set to "
    "'Anyone with the link can view'. Paste the resulting "
    "`https://drive.google.com/drive/folders/...?usp=sharing` URL into the "
    "Drive Link field (avoid `/u/0/`, `/u/1/`, `/u/3/` — those are "
    "account-scoped and won't work for automation).\n\n"
    "Once re-shared, the next pipeline run in **incremental mode** will "
    "auto-retry this task."
)
```

### 1.5d — `--retry-failed` mode

When the user passes `--retry-failed`, STEP 1 changes: instead of fetching the whole list, read `/tmp/<pipeline>/cu_result_*.json` from the prior run, filter `success=false`, then re-fetch each task's **current** Drive URL from ClickUp (the user likely updated it), and run STEP 1.5 preflight on only those. This is the "user re-shared, let's try again" workflow.

If the previous run's JSON directory is missing, fall back to fetching the whole list and filtering to tasks where Angle/Hook/Creative-Structure are still empty (the incremental-mode criteria).

---

## STEP 2 — Split into batches + spawn parallel agents

| Task count | Agents | Tasks/agent |
|---|---|---|
| 1–15 | Run inline | — |
| 16–50 | 5 agents | ~10 each |
| 51–100 | 10 agents | ~10 each |
| 101–200 | 14 agents | ~12 each |
| 200+ | 20 agents | ~10 each |

Write batch files: `/tmp/cu_batch_{N}.json` — array of task objects.
Spawn all agents in a single message with `run_in_background: true`.

### 2a. Canonical result schema (REQUIRED — do not deviate)

Every agent **MUST** write `/tmp/cu_result_{task_id}.json` with this exact key set. This schema is the contract between agents and the writeback step. Historical bug: batches used `id`/`name` instead of `task_id`/`task_name`, crashing writeback with `KeyError`.

```json
{
  "task_id": "86d2XXXX",                   // REQUIRED — string, from input batch
  "task_name": "Art Therapy; 11439",       // REQUIRED — string, from input batch
  "status": "testing",                     // from ClickUp, or "unknown"
  "drive_url": "https://drive...",         // from input batch
  "success": true,                         // REQUIRED — bool

  "creative_modality": "VO-Driven",        // NEW — REQUIRED when photo_video=Video
  "photo_video": "Video",
  "hook_type": "Pain / Problem",
  "creative_structure": "Hook + Offer",
  "production_style": "Organic / Raw UGC",
  "funnel_type": "TOF",
  "angle": "Art as Therapy Alternative",
  "persona": "Stressed Women 25-45",
  "creative_usp": "...",
  "creative_hypothesis": "...",
  "notes": "...",

  "vo_transcript_timed": [                 // NEW — voiceover lines, empty if no VO
    {"t": "0-2", "text": "POV: my favorite kind of therapy", "confidence": "high"}
  ],
  "osd_text_timed": [                      // NEW — on-screen display (captions/overlays)
    {"t": "0-2", "text": "So I went", "position": "bottom", "confidence": "high"}
  ],

  "verification_notes": "VO reconstructed from captions; music/VO split confirmed via audio RMS.",
  "brief_markdown": "## 1. SNAPSHOT ...",
  "frames_extracted": 6,
  "clickup_doc_page_id": null,             // filled after doc write
  "error": null
}
```

**Forbidden key names** (historical mistakes — will fail validator): `id`, `name`, `body_copy_from_frames`, `id_clickup`, `task`.

### 2b. Agent prompt template (copy verbatim into each spawn)

```
You are processing batch {N} of the creative pipeline. Inputs:
- Batch file:        /tmp/cu_batch_{N}.json   (array of {task_id, task_name, drive_url, status})
- Result directory:  /tmp/                      (write cu_result_{task_id}.json for each task)
- ClickUp API key:   <key>
- Doc ID:            <doc_id>   Workspace ID: <ws_id>
- Known Angles:      [list]     Known Personas: [list]
- Field IDs:         <FIELDS dict>
- Dropdown UUIDs:    <HOOK_OPTS, STRUCT_OPTS, PROD_OPTS, PV_OPTS, FUNNEL_OPTS>

For each task: Step 3a → 3b → 3c → 3d → write cu_result_{task_id}.json per §2a schema.

HARD RULES:
1. Use EXACTLY these keys: task_id, task_name, success, creative_modality, photo_video,
   hook_type, creative_structure, production_style, funnel_type, angle, persona,
   creative_usp, creative_hypothesis, notes, vo_transcript_timed, osd_text_timed,
   verification_notes, brief_markdown, frames_extracted, drive_url, status, error.
   NEVER use `id` or `name` (both crash the writeback).
2. If you cannot determine a field, set it to null — never omit the key.
3. Before writing the result file, validate: `set(result.keys()) >= REQUIRED_KEYS`.
4. For video tasks, also run the audio probe in §3b to populate creative_modality.
5. If classification fails, still write the result with success=false + error=<reason>.
```

### 2c. Pre-writeback validator (runs once after all agents finish)

```python
import json, glob, os
REQUIRED = {"task_id","task_name","success","photo_video","hook_type",
            "creative_structure","production_style","funnel_type","angle","persona",
            "creative_usp","creative_hypothesis","notes","brief_markdown"}

def normalize_result(path):
    d = json.load(open(path))
    # Legacy-key auto-fix (prevents the April 20 KeyError crash from recurring)
    if "task_id" not in d and "id" in d:     d["task_id"]   = d.pop("id")
    if "task_name" not in d and "name" in d: d["task_name"] = d.pop("name")
    # Infer task_id from filename if still missing
    if not d.get("task_id"):
        base = os.path.basename(path)
        d["task_id"] = base.replace("cu_result_","").replace(".json","")
    # Pad missing required keys with None so downstream doesn't KeyError
    for k in REQUIRED:
        d.setdefault(k, None)
    json.dump(d, open(path, "w"), indent=2)
    return d, sorted(k for k in REQUIRED if d.get(k) in (None, ""))

bad = []
for p in glob.glob("/tmp/cu_result_*.json"):
    d, missing = normalize_result(p)
    if missing: bad.append((d["task_id"], missing))

print(f"Validated {len(glob.glob('/tmp/cu_result_*.json'))} results; "
      f"{len(bad)} have missing fields.")
for tid, miss in bad[:10]:
    print(f"  {tid}: {miss}")
```

If any task has `success=true` but a missing required field, halt and ask the user before writeback.

---

## STEP 3 — Per-task pipeline (each agent does this for its tasks)

### 3a. Download from Google Drive

```python
import subprocess, re, os, glob, shutil

# Normalize Drive URLs. Google sometimes puts /u/0/ or /u/1/ in the path
# (account-scoped view). The account-scoped URLs only work if the folder
# is actually shared publicly; stripping /u/N/ doesn't grant access to
# private folders — it just gives cleaner errors. If gdown returns an
# empty folder for a /u/1/ URL, that folder is private and the task
# should be skipped with status "private_folder_or_access_denied".
def normalize_drive_url(u):
    return re.sub(r'/drive/u/\d+/', '/drive/', u or '')

def video_or_image(path):
    """Return type tag or None if neither."""
    lo = path.lower()
    if lo.endswith(('.mp4', '.mov', '.mkv', '.webm')): return 'video'
    if lo.endswith(('.jpg', '.jpeg', '.png', '.webp')): return 'image'
    return None

work_dir = f"/tmp/cu_work_{task_id}"
os.makedirs(work_dir, exist_ok=True)
url = normalize_drive_url(drive_url)

# Case A — folder URL: use gdown --folder to download everything at once.
# (There is NO --dry-run flag in gdown; we were wrong to use it before.)
# gdown creates a subdirectory inside work_dir named after the folder,
# so we glob the whole work_dir recursively to find files.
m_folder = re.search(r'/folders/([a-zA-Z0-9_-]+)', url)
m_file   = re.search(r'/file/d/([a-zA-Z0-9_-]+)', url)

downloaded = None
if m_folder:
    try:
        subprocess.run(
            ["python3", "-m", "gdown", "--folder", url,
             "-O", work_dir, "--quiet"],
            capture_output=True, text=True, timeout=300, check=False)
    except subprocess.TimeoutExpired:
        pass
    # Pick the first video, else the first image, else give up
    all_files = sorted(glob.glob(f"{work_dir}/**/*", recursive=True))
    vids = [f for f in all_files if video_or_image(f) == 'video' and os.path.getsize(f) > 10000]
    imgs = [f for f in all_files if video_or_image(f) == 'image' and os.path.getsize(f) > 10000]
    if vids:
        downloaded = vids[0]
    elif imgs:
        downloaded = imgs[0]
elif m_file:
    # Single-file share link — download directly via requests (not gdown).
    import requests
    fid = m_file.group(1)
    for ext in ('.mp4', '.mov', '.jpg', '.jpeg', '.png'):
        dest = f"{work_dir}/creative{ext}"
        r = requests.get(
            f"https://drive.usercontent.google.com/download?id={fid}&export=download&authuser=0&confirm=t",
            stream=True, timeout=120)
        size = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(65536):
                if chunk: f.write(chunk); size += len(chunk)
        # Detect HTML-return (private/error) by first bytes
        with open(dest, "rb") as f: head = f.read(200)
        if size > 10000 and not head.startswith(b"<!DOCTYPE") and not head.lower().startswith(b"<html"):
            downloaded = dest
            break
        os.remove(dest)

# If still nothing, mark as private/missing and skip this task
if not downloaded:
    result = {"task_id": task_id, "success": False,
              "error": "private_folder_or_empty_or_no_media",
              "drive_url": drive_url}
    # write result JSON and continue to next task
```

### 3b. Extract frames + audio probe (NEW — audio-aware)

Lesson from the AT-VID-001 correction (Apr 20 2026): a VO-driven ad was misclassified as music-style because frames alone can't reveal what's on the audio track. Fix: probe audio with ffmpeg before classification so the model knows whether there's a voice.

```python
import subprocess, glob, shutil, json, re

# 1. Extract frames (one every 5s, max 6 frames)
if downloaded and downloaded.endswith(('.mp4', '.mov', '.mkv', '.webm')):
    subprocess.run([
        "ffmpeg", "-i", downloaded,
        "-vf", "fps=1/5,scale=800:-1", "-q:v", "2",
        f"{work_dir}/frame_%03d.jpg"
    ], capture_output=True)
elif downloaded:  # image
    shutil.copy(downloaded, f"{work_dir}/frame_001.jpg")

frames = sorted(glob.glob(f"{work_dir}/frame_*.jpg"))[:6]

# 2. Audio probe (video only) — tells the classifier whether VO is present
audio_probe = {"has_audio": False, "has_voice": None, "rms_db": None, "duration": None}
if downloaded and downloaded.endswith(('.mp4','.mov','.mkv','.webm')):
    # ffprobe for duration + audio stream existence
    probe = subprocess.run([
        "ffprobe","-v","error","-print_format","json",
        "-show_format","-show_streams", downloaded
    ], capture_output=True, text=True)
    try:
        meta = json.loads(probe.stdout)
        audio_probe["duration"] = float(meta.get("format",{}).get("duration") or 0)
        audio_probe["has_audio"] = any(s.get("codec_type")=="audio" for s in meta.get("streams",[]))
    except Exception:
        pass

    if audio_probe["has_audio"]:
        # Extract audio, then measure RMS in speech band (80Hz-3kHz) vs full band
        wav = f"{work_dir}/audio.wav"
        subprocess.run(["ffmpeg","-y","-i",downloaded,"-vn","-ac","1","-ar","16000", wav],
                       capture_output=True)
        # Speech-band RMS
        speech = subprocess.run([
            "ffmpeg","-i",wav,"-af",
            "highpass=f=80,lowpass=f=3000,astats=metadata=1:reset=1",
            "-f","null","-"], capture_output=True, text=True).stderr
        # Full-band RMS
        full = subprocess.run([
            "ffmpeg","-i",wav,"-af","astats=metadata=1:reset=1","-f","null","-"],
            capture_output=True, text=True).stderr
        def rms(txt):
            m = re.search(r"RMS level dB: (-?\d+\.\d+)", txt)
            return float(m.group(1)) if m else None
        s_db, f_db = rms(speech), rms(full)
        audio_probe["rms_db"] = f_db
        # Heuristic: if speech-band RMS is within 3dB of full-band, voice is probably dominant
        if s_db is not None and f_db is not None:
            audio_probe["has_voice"] = (f_db - s_db) < 3.0
        # Keep the wav — used later for optional Whisper transcription

# 3. Save probe result for the classifier to read
json.dump(audio_probe, open(f"{work_dir}/audio_probe.json","w"))

# 4. Optional: if has_voice and you have OpenAI/Whisper available, transcribe:
#    This is the ground-truth VO transcript. Skip if unavailable — the classifier
#    can reconstruct from captions and the modality heuristic still holds.
# subprocess.run(["whisper", f"{work_dir}/audio.wav", "--model","base","--output_format","json",
#                 "--output_dir", work_dir], capture_output=True)

os.remove(downloaded) if downloaded and os.path.exists(downloaded) else None
```

### 3c. Visually classify (Read tool — up to 6 frames + audio probe)

You are a senior media buyer. Before classifying, **always read `{work_dir}/audio_probe.json`** — it tells you whether a human voice is on the audio track. This directly drives `creative_modality`.

**Classification fields:**

| Field | Valid values |
|---|---|
| photo_video | Video, Photo |
| **creative_modality** (NEW) | VO-Driven, Music-Driven, Caption-Driven, Demo-Driven, Silent-Visual, Static (Photo) |
| hook_type | Pain / Problem, Fear, Curiosity, Social Proof, Aspirational, Direct Offer, Controversy / Bold Claim, POV, Question, Pattern Interrupt |
| creative_structure | UGC, Testimonial, Demo, Tutorial/How-To, Story/Narrative, Hook+Offer, Listicle, Static/Photo, Comparison, Interview, Skit/Roleplay, AI/Voiceover |
| production_style | Organic/Raw UGC, Polished UGC, Professional Studio, AI Generated, Screen Record, Animation/Motion, Static Graphic, Slideshow, Repurposed Organic, Competitor Inspired |
| funnel_type | TOF, MOF, BOF |
| angle | Match known angles (≥60% → exact name; else 2-5 word new label) |
| persona | Match known personas (≥60% → exact name; else 4-6 word new label) |
| creative_usp | 20 words max |
| creative_hypothesis | 2 sentences: why made + why it works. 35 words max |
| notes | What you literally see. 30 words max |

**Modality decision tree:**
- `audio_probe.has_voice == True` → candidate is **VO-Driven**; confirm captions are subtitles to a voice, not standalone text
- `audio_probe.has_voice == False` and `has_audio == True` → **Music-Driven** (music bed only, captions carry story)
- `audio_probe.has_audio == False` → **Silent-Visual** or **Caption-Driven** depending on on-screen text density
- Photo task → **Static (Photo)**
- Screen-recording of app/product demo with pointer/UI → **Demo-Driven** (override modality from audio)

**Transcript fields (NEW — replaces the old single `body_copy_from_frames`):**

| Field | What goes here |
|---|---|
| `vo_transcript_timed` | Array of `{t: "start-end", text, confidence}`. Populate only if `has_voice`. Reconstruct from captions when Whisper isn't available — **mark confidence as "medium"** and note this in `verification_notes`. |
| `osd_text_timed` | Array of `{t, text, position, confidence}` for every burned-in caption, top overlay, watermark, or end-card text. This is **ground truth** from frame OCR — confidence "high." |
| `verification_notes` | One short paragraph stating: what was observed vs reconstructed, whether audio probe ran, whether Whisper ran, any uncertainty flags. This is the bug-prevention layer — missing this field was the root cause of the 5773-1 misclassification. |

### 3d. Build the 12-section brief (upgraded)

This template is modeled on the AT-VID-001 gold-standard brief. Every output has the same 12 sections so downstream readers (editors, strategists, paid media) know exactly where to look.

```
1. SNAPSHOT            table: task_id, funnel, modality, hook, structure, angle, persona, drive
2. CREATIVE BREAKDOWN  | Time | VO (if any) | OSD text | Visual | Emotion |
3. WHY IT WORKS        4-5 psychological mechanisms tied to specific timestamps
4. REPLICATION BRIEF   talent, set, overlays, pacing, music, end card — prose
5. WHAT TO TEST        isolated-variable matrix (see §3d.1 below)
6. COMPETITOR INTEL    scale, funnel, gap, lane decision
7. OUR NEXT AD         steal, differ, 3-bullet editor brief, hypothesis
8. PERSONA LOCK        §3d.2 — feels / must-never-feel
9. ANGLE LOCK          §3d.3 — voice rules / phrases that work / phrases that BREAK
10. LOCKED ELEMENTS    §3d.4 — what never changes if scaling
11. PRODUCTION SPEC    §3d.5 — aspect, fps, LUFS, captions, end card table
12. HAND-OFF CHECKLIST §3d.6 — editor TODOs with owner names
13. VERIFICATION NOTES §3d.7 — confidence flags + policy lint
```

#### 3d.1 — Isolated-variable test matrix (replaces flat "5 ideas")

Instead of 5 disconnected test ideas, produce a matrix: **2-4 sets × 3 variations**, each set changes exactly one variable. AT-VID-001 uses Hook Visual / VO Delivery / VO CTA Tail / VO Script. Pick variables appropriate to the modality:

| Modality | Recommended test axes |
|---|---|
| VO-Driven | Hook Visual · VO Delivery Style · VO CTA Tail · VO Script |
| Music-Driven | Hook 0-3s · Music Track · Caption Rhythm · End-Card Offer |
| Caption-Driven | Hook Caption · Caption Cadence · Visual B-Roll · CTA Caption |
| Demo-Driven | App-Screen Opener · VO Script · Pain Hook · CTA End-Card |
| Static (Photo) | Hook Headline · Primary Image · Color Palette · CTA |

Produce a markdown table like:

```
| Set | Variable | V1 | V2 | V3 | Everything held constant |
|-----|---|---|---|---|---|
| S1  | Hook Visual (0-5s) | Paper quilling | Watercolor bloom | Zentangle mandala | Full VO, music, captions, product section |
| S2  | ... | ... | ... | ... | ... |
```

#### 3d.2 — PERSONA LOCK section (extends old PERSONA ANALYSIS)

| Row | Content |
|---|---|
| Demographics | Age range · gender · life stage · platforms |
| Core Pain Points (3) | Bullets, concrete, lived-experience language |
| What She Wants | The emotional outcome, not the product |
| How This Creative Speaks to Her | Map specific beats to specific needs |
| **What She Feels When This Ad Lands** (NEW) | 4-5 bullets — Recognition / Trust / Desire / Action moments |
| **What She Must NEVER Feel** (NEW — bug-prevention) | 4-5 bullets — Shame / Overwhelm / Sales pressure / Clinical coldness |
| Messaging That Resonates | 3-5 phrase examples (≤ 6 words each) |
| Messaging to Avoid | 3-5 phrases that break the trust |

#### 3d.3 — ANGLE LOCK section (extends old ANGLE ANALYSIS)

| Row | Content |
|---|---|
| Core Insight | One sentence |
| Why It Works | 2-3 sentences |
| How It's Executed Here | Tie to specific timestamps |
| **Voice Rules** (NEW) | 4-6 bullets — "First person always", "Past tense for experience, present for share", "Warm quiet confidence", etc. |
| **Phrases That Work** (NEW) | 4-6 exact phrases matching the angle |
| **Phrases That BREAK the Angle** (NEW — the lint layer) | 4-6 exact phrases that violate the angle voice |
| Variants to Explore | 3 angle-consistent variant directions |

#### 3d.4 — LOCKED ELEMENTS section (NEW)

If this creative is a winner and we scale it, document what must never change or we lose the thing that worked:

```
| Element | Detail (what the winning version uses) |
|---|---|
| Length | 29 seconds exactly |
| VO voice | ElevenLabs "Rachel" warm-conversational (lock character) |
| Music bed | Soft ambient, ducked -18 LUFS under VO |
| Caption style | White pill, bottom-third, 3-5 words per beat |
| Top overlay | "POV:" hook 0-5s, "Get this now" 17-29s |
| Watermark | "FREE today" 40% opacity, centered, 5-17s |
| End card URL | mindingart.com (NOT printableswithlily.com) |
| Props | Pink roses + framed art + colored pencils — identical |
| Child demo | Same child, striped shirt, wooden desk |
```

Populate per creative. For a generic task without scale data yet, populate from what's visible in frames.

#### 3d.5 — PRODUCTION SPEC section (NEW — hard technical table)

```
| Spec | Value |
|---|---|
| Aspect ratio | 9:16 vertical |
| Resolution | 1080×1920 preferred (720×1280 minimum) |
| Frame rate | 30fps |
| Length | {duration}s ±1s |
| Audio mix | VO 0 dB / music -18 LUFS ducked under VO |
| Sample rate | 44.1 kHz stereo |
| Caption style | White pill, rounded corners, black text, bottom-third |
| Top overlay style | White sans-serif, centered, slight drop shadow |
| Watermark | 40% opacity, centered, "FREE today" or offer text |
| End card | 1-second product cover + URL |
| Filename convention | `{ad_id}-{set}{variation}_{descriptor}.mp4` (e.g. `5773-1-S1V1_quilling.mp4`) |
```

#### 3d.6 — HAND-OFF CHECKLIST section (NEW)

```
**For editor (Nitin / Shivam / Samriddhi / Kirti — replace with your team):**

- [ ] Watch the original creative in full before attempting variation
- [ ] Listen to VO in isolation (strip music if present) to lock delivery match
- [ ] Confirm which ElevenLabs voice is used (lock for Set 2 V2 control)
- [ ] Read PERSONA LOCK + ANGLE LOCK top to bottom
- [ ] Source OR shoot Set 1 hook clips (3 variations)
- [ ] Render Set 2 VOs via ElevenLabs (3 different voice characters, same script)
- [ ] Render Set 3 VO tails (3 different closes, same voice as original)
- [ ] Re-burn captions for Set 4 to match each new VO word-for-word
- [ ] Meta policy check: no "FREE TODAY" as standalone headline; flag $ claims
- [ ] Week 1 deliverables: Set 1 + Set 4 (6 videos) in 5 working days
- [ ] Week 2 deliverables: Set 2 + Set 3 (6 videos) within 7 days of Week 1 approval
```

#### 3d.7 — VERIFICATION NOTES section (NEW — bug-prevention layer)

Every brief ends with a short verification block:

```
**Verification confidence:**
- Frames observed: {N} at 5-second intervals ✅
- Audio probe ran: {yes/no}, has_voice={true/false/null}
- VO transcript source: {Whisper ground-truth / reconstructed from captions / not applicable}
- OSD text: OCR'd from frames — high confidence ✅
- Modality classification driven by: {audio_probe / caption density / visual cues}
- Known unknowns: {e.g. "Original ElevenLabs voice name not confirmed; lock via Slack before producing Set 2 V2"}

**Meta policy lint:** {PASS / FLAG with reason}
- "FREE TODAY" as standalone headline: {not present / present — move to subtitle}
- Price anchor in headline ("$99 / FREE TODAY"): {not present / present — keep in subtitle only}
- Clinical claims ("evidence-based", "clinically proven"): {not present / present — soften}
- Superlatives ("best ever", "game-changer"): {not present / present — remove}
```

If any lint item fails, surface the flag in the ClickUp comment too so the reviewer sees it without opening the doc.

---


---

## STEP 3.5 — Consolidation checkpoint (new)

After all agents finish classifying, **do NOT write anything to ClickUp yet.** Collect every agent's output into `results[]` (the list of dicts each agent wrote to `/tmp/pipeline_<task_id>.json`).

Then split the proposed Angles and Personas into three buckets per field:

| Bucket | Definition |
|---|---|
| **EXACT** | `result["angle"]` matches an existing dropdown option name case-insensitively. No action needed. |
| **FUZZY** | `result["angle"]` has a 60%+ word-overlap with an existing option (use the helper below). Auto-map to that existing option; still surface to user for sanity check. |
| **NEW** | No match. Candidate for a new dropdown option. **Requires user approval before ClickUp write.** |

### 3.5a — Clustering helper

```python
def normalize(s):
    return (s or "").lower().strip()

def word_overlap_ratio(a, b):
    """Jaccard overlap of meaningful words (length ≥ 4). Returns 0.0–1.0."""
    wa = {w for w in normalize(a).split() if len(w) >= 4}
    wb = {w for w in normalize(b).split() if len(w) >= 4}
    if not wa or not wb: return 0.0
    return len(wa & wb) / len(wa | wb)

def classify_proposals(proposals, existing_options, threshold=0.6):
    """Return dict: {'exact': [...], 'fuzzy': [(proposed, matched_canonical)], 'new': [...]}"""
    existing_lc = {normalize(o["name"]): o["name"] for o in existing_options}
    result = {"exact": [], "fuzzy": [], "new": []}
    for p in proposals:
        pn = normalize(p)
        if pn in existing_lc:
            result["exact"].append(p)
        else:
            best = None; best_ratio = 0.0
            for lc, canonical in existing_lc.items():
                r = word_overlap_ratio(p, canonical)
                if r > best_ratio:
                    best_ratio = r; best = canonical
            if best and best_ratio >= threshold:
                result["fuzzy"].append((p, best, best_ratio))
            else:
                result["new"].append(p)
    return result
```

### 3.5b — Cluster NEW proposals into similarity groups

If there are 3+ NEW proposals, use the same `word_overlap_ratio` against each other to merge near-duplicates (e.g. "Marriage Prediction" + "Marriage Forecast" + "Future Spouse Reading" → one cluster). Suggest a canonical label per cluster (the longest proposal by default, or the most common).

```python
def cluster_similar(items, threshold=0.6):
    """Group items where word_overlap_ratio >= threshold. Returns list of clusters."""
    remaining = list(items); clusters = []
    while remaining:
        seed = remaining.pop(0)
        cluster = [seed]
        remaining = [
            x for x in remaining
            if not (word_overlap_ratio(seed, x) >= threshold and cluster.append(x) or False)
        ]
        clusters.append(cluster)
    return clusters
```

### 3.5c — Present to the user and WAIT for approval

Print a report that looks like this (example with real clusters):

```
═══════════════════════════════════════════════════════════════════════════
  CONSOLIDATION CHECKPOINT — Angles
═══════════════════════════════════════════════════════════════════════════

✅ 23 tasks matched existing angle exactly. No action needed.

⚠️  7 tasks fuzzy-matched (≥60%) — auto-mapped to existing:
    • "Marriage & Partnership"      → "Marriage Prediction"        (3 tasks)
    • "Future spouse identification" → "Marriage Prediction"        (2 tasks)
    • "Palm reading demo"            → "Palm Reading"               (2 tasks)

🆕 5 NEW angle clusters found (not in existing dropdown):
  [N1]  "Wealth Attraction" + "Money Manifestation" + "Prosperity Mantra"   (3 tasks)
        Suggested canonical: "Wealth Attraction"

  [N2]  "AI Astrology Demo"                                                  (2 tasks)
        Suggested canonical: "AI Astrology Demo"

  [N3]  "Career Success Prediction"                                          (1 task)
        Suggested canonical: "Career Success Prediction"

── What should I do with the NEW clusters? ──
  [a] Accept all suggested canonicals + add them as new dropdown options
  [r] Review each cluster individually (rename / split / merge / drop)
  [s] Skip ClickUp angle writes for NEW proposals; leave Angle blank on those tasks
  [f] Show me each task's full context for clusters I'm unsure about
```

Wait for the user's choice. If `[r]` is picked, iterate cluster-by-cluster:

```
[N1] Wealth Attraction + Money Manifestation + Prosperity Mantra  (3 tasks)
     Suggested canonical: "Wealth Attraction"
     Options: [a]ccept, [c]ustom rename, [m]erge-into-existing <name>, [s]plit, [d]rop
     Your choice: _
```

After all angles are resolved, repeat the same flow for Personas.

### 3.5d — Apply user's decisions to results in memory

Build a mapping `angle_mapping: {proposed_label → final_label_to_write}` (and the same for persona). Apply to every entry in `results[]`:

```python
for r in results:
    r["angle_final"]   = angle_mapping.get(r["angle"], r["angle"])
    r["persona_final"] = persona_mapping.get(r["persona"], r["persona"])
```

From here on, all ClickUp writes use `*_final` values. NEW options approved by the user are added to the dropdown before the per-task writes (ClickUp MCP: `clickup_add_dropdown_option` or equivalent API call — if the ClickUp API rejects, fall back to text/short_text field and warn the user).

### 3.5e — Edge case: `--skip-consolidation` flag

If the user passed `--skip-consolidation`, bypass the approval UI: auto-accept all suggested canonicals, create all NEW options automatically, log what was done in the final summary. Use only when you trust the existing dropdown to absorb everything cleanly.

## STEP 4 — Create ClickUp Doc page

Use `clickup_create_document_page` MCP tool:
```
document_id: <DOC_ID>
name: "{task_name} — {angle}"
sub_title: "Facebook/Meta · {funnel_type} · {hook_type} hook"
content_format: "text/md"
content: <full markdown below>
```

**Page markdown template (13 sections — matches §3d):**

```markdown
# {task_name} — {angle}

---

## 1. SNAPSHOT
| Field | Value |
|---|---|
| **Task ID** | {task_id} |
| **Task Name** | {task_name} |
| **Platform** | Facebook / Meta |
| **Funnel** | {funnel_type} |
| **Format** | {photo_video} — {production_style} |
| **Modality** | {creative_modality}  ← NEW |
| **Hook Type** | {hook_type} |
| **Creative Structure** | {creative_structure} |
| **Angle** | {angle} |
| **Persona** | {persona} |
| **Status** | {status} |
| **Drive Link** | {drive_url} |

**Creative USP:** {creative_usp}
**In one sentence:** {creative_hypothesis}
**Notes:** {notes}

---

## 2. CREATIVE BREAKDOWN
{FRAME_BY_FRAME table: | Time | VO (if any) | OSD text | Visual | Emotion |}

*VO transcript and OSD text rendered side-by-side from `vo_transcript_timed` + `osd_text_timed`. If modality is Music/Caption/Static/Silent, the VO column is N/A.*

---

## 3. WHY IT WORKS
{4-5 psychological mechanisms, each tied to a specific timestamp in §2}

---

## 4. REPLICATION BRIEF
{talent, set, overlays, pacing, music, end card — prose}

---

## 5. WHAT TO TEST (isolated-variable matrix)
| Set | Variable | V1 | V2 | V3 | Everything held constant |
|-----|---|---|---|---|---|
| S1  | ... | ... | ... | ... | ... |
| S2  | ... | ... | ... | ... | ... |
...

**Kill rules:** $15 spend + CTR <2.5% → kill early. $50 spend + ROAS <0.85 → kill late.
**Winner threshold:** ROAS >1.5 at $100 spend → scale. CTR >3.5% → hook winner.

---

## 6. COMPETITOR INTEL
{scale, funnel, gap, lane decision}

---

## 7. OUR NEXT AD
{steal, differ, 3-bullet editor brief, hypothesis}

---

## 8. PERSONA LOCK
| Attribute | Detail |
|---|---|
| **Demographics** | ... |
| **Core Pain Points** | ... |
| **What She Wants** | ... |
| **How This Creative Speaks to Her** | ... |
| **What She Feels When This Ad Lands** | 1. ... / 2. ... / 3. ... / 4. ... |
| **What She Must NEVER Feel** | 1. ... / 2. ... / 3. ... / 4. ... |
| **Messaging That Resonates** | ... |
| **Messaging to Avoid** | ... |

---

## 9. ANGLE LOCK
- **Core Insight:** ...
- **Why It Works:** ...
- **How It's Executed Here:** ...
- **Voice Rules:**
  - ...
  - ...
- **Phrases That Work:** ..., ..., ...
- **Phrases That BREAK the Angle:** ..., ..., ...
- **Variants to Explore:** ...

---

## 10. LOCKED ELEMENTS (if we scale this, never change these)
| Element | Value |
|---|---|
| Length | ... |
| VO voice | ... |
| Music bed | ... |
| Caption style | ... |
| Top overlay | ... |
| Watermark | ... |
| End card URL | ... |
| Props / Set | ... |

---

## 11. PRODUCTION SPEC
| Spec | Value |
|---|---|
| Aspect ratio | 9:16 vertical |
| Resolution | 1080×1920 preferred |
| Frame rate | 30fps |
| Length | ... |
| Audio mix | VO 0 dB / music -18 LUFS ducked |
| Caption style | ... |
| End card | ... |
| Filename convention | `{ad_id}-{set}{variation}_{descriptor}.mp4` |

---

## 12. HAND-OFF CHECKLIST
- [ ] Watch original in full
- [ ] Listen to VO in isolation
- [ ] Confirm ElevenLabs voice name
- [ ] Source / shoot Set 1 variations
- [ ] Render Set 2 VOs (different voice characters)
- [ ] Render Set 3 VO tails (same voice, different close)
- [ ] Re-burn captions for Set 4
- [ ] Meta policy check (see §13 lint)
- [ ] Week 1 deliverables in 5 working days
- [ ] Week 2 deliverables within 7 days of Week 1 approval

---

## 13. VERIFICATION NOTES
- Frames observed: {N} at 5s intervals ✅
- Audio probe: {ran / skipped}, has_voice={true / false / null}
- VO transcript source: {Whisper ground-truth / reconstructed from captions / N/A}
- OSD text: OCR'd from frames — high confidence ✅
- Modality driver: {audio_probe / caption density / visual cues}
- Known unknowns: ...

**Meta policy lint:** {PASS / FLAG}
- "FREE TODAY" standalone headline: ...
- Price anchor in headline: ...
- Clinical claims: ...
- Superlatives: ...
```

---

## STEP 5 — Update ClickUp task (12 operations + optional policy-flag surfacing)

If the list has a `Creative Modality` field, write to it. If not, auto-create it (see below).

```python
# Auto-create creative_modality dropdown field on the list if it doesn't exist yet.
# Run this once per list, not per task.
def ensure_modality_field(list_id, api_key):
    r = requests.get(f"https://api.clickup.com/api/v2/list/{list_id}/field",
                     headers={"Authorization": api_key})
    fields = r.json().get("fields", [])
    for f in fields:
        if f["name"].lower() in ("creative modality","modality"):
            return f["id"], {o["name"]: o["id"] for o in f.get("type_config",{}).get("options",[])}
    # Create it
    body = {"name": "Creative Modality", "type": "drop_down",
            "type_config": {"options": [
                {"name":"VO-Driven","color":"#7b68ee"},
                {"name":"Music-Driven","color":"#ff7f50"},
                {"name":"Caption-Driven","color":"#1bbc9c"},
                {"name":"Demo-Driven","color":"#f39c12"},
                {"name":"Silent-Visual","color":"#95a5a6"},
                {"name":"Static (Photo)","color":"#bdc3c7"},
            ]}}
    # NOTE: ClickUp's POST /list/{id}/field endpoint currently requires admin auth.
    # If it fails with 401/403, fall back to a text field named "Creative Modality"
    # and set the raw string value.
    ...
```

**Per-task writes:**

```python
doc_url = f"https://app.clickup.com/{WORKSPACE_ID}/docs/{DOC_ID}/{page_id}"

def set_field(task_id, field_id, value):
    r = requests.post(f"{BASE}/task/{task_id}/field/{field_id}",
        headers=HEADERS, json={"value": value})
    return r.status_code == 200

# 1. Prepend doc link to description
task_data = requests.get(f"{BASE}/task/{task_id}", headers=HEADERS).json()
existing_desc = task_data.get("description") or ""
if doc_url not in existing_desc:
    new_desc = f"📄 Creative Brief: {doc_url}\n\n{existing_desc}".strip()
    requests.put(f"{BASE}/task/{task_id}", headers=HEADERS, json={"description": new_desc})

# 2. Add comment — include policy-lint flags inline so reviewers see without opening doc
lint = result.get("meta_policy_lint", {})
lint_line = ""
if lint and not lint.get("pass", True):
    lint_line = f"\n\n⚠️ **Policy flags:** {', '.join(lint.get('flags', []))}"

comment = (
    f"📄 Creative Brief: {doc_url}\n\n"
    f"Full visual analysis, frame-by-frame breakdown, persona + angle LOCK, "
    f"locked elements, production spec, and hand-off checklist in the doc.\n\n"
    f"Angle: {angle} | Persona: {persona} | Hook: {hook_type} | "
    f"Modality: {creative_modality} | Funnel: {funnel_type}"
    f"{lint_line}"
)
requests.post(f"{BASE}/task/{task_id}/comment", headers=HEADERS, json={"comment_text": comment})

# 3-12. Custom fields
set_field(task_id, FIELDS["angle_tag"], angle)
set_field(task_id, FIELDS["persona_tag"], persona)
set_field(task_id, FIELDS["creative_usp"], creative_usp)
set_field(task_id, FIELDS["notes"], notes[:200])
if hook_type in HOOK_OPTS:            set_field(task_id, FIELDS["hook_type"], HOOK_OPTS[hook_type])
if creative_structure in STRUCT_OPTS: set_field(task_id, FIELDS["creative_structure"], STRUCT_OPTS[creative_structure])
if funnel_type in FUNNEL_OPTS:        set_field(task_id, FIELDS["funnel_type"], FUNNEL_OPTS[funnel_type])
if photo_video in PV_OPTS:            set_field(task_id, FIELDS["photo_video"], PV_OPTS[photo_video])
if production_style in PROD_OPTS:     set_field(task_id, FIELDS["production_style"], PROD_OPTS[production_style])

# NEW: Creative Modality field — dropdown if it was auto-created, else text
if MODALITY_FIELD_ID:
    if creative_modality in MODALITY_OPTS:
        set_field(task_id, MODALITY_FIELD_ID, MODALITY_OPTS[creative_modality])
    else:
        set_field(task_id, MODALITY_FIELD_ID, creative_modality)  # text fallback
```

---

## STEP 6 — Save result + cleanup

Each agent writes `/tmp/cu_result_{task_id}.json` matching the **Canonical result schema** in §2a. Full shape reproduced here for easy reference:

```json
{
  "task_id": "86d2XXXX", "task_name": "...", "status": "...",
  "success": true,
  "creative_modality": "VO-Driven",
  "photo_video": "Video", "hook_type": "...",
  "creative_structure": "...", "production_style": "...",
  "funnel_type": "...", "angle": "...", "angle_matched": true,
  "persona": "...", "persona_matched": true,
  "creative_usp": "...", "creative_hypothesis": "...", "notes": "...",
  "vo_transcript_timed":  [{"t":"0-2","text":"...","confidence":"high"}],
  "osd_text_timed":       [{"t":"0-2","text":"...","position":"bottom","confidence":"high"}],
  "verification_notes":   "VO reconstructed from captions; audio probe confirms has_voice=true.",
  "meta_policy_lint":     {"pass": true, "flags": []},
  "brief_markdown":       "## 1. SNAPSHOT ...",
  "frames_extracted":     6,
  "clickup_doc_page_id":  "<your-doc-id>-<page>",
  "drive_url":            "https://drive...",
  "error":                null
}
```

**REMINDER:** Never use `id` or `name` — use `task_id` and `task_name`. The §2c validator will auto-normalize legacy keys, but agents should write the correct keys on the first try.

Cleanup: `rm -rf /tmp/cu_work_{task_id}` (keep `audio.wav` for 24h in case re-analysis is needed)

---

## STEP 7 — Fix-up pass (run after all agents complete)

Re-set any `creative_structure` values that may have used wrong UUIDs:

```python
import glob, json

results = []
for path in glob.glob("/tmp/cu_result_*.json"):
    try: results.append(json.load(open(path)))
    except: pass

NEEDS_VERIFY = {"Listicle","Static/Photo","Tutorial/How-To","Slideshow/Compilation","AI/Voiceover"}
fixed = 0
for r in results:
    cs = r.get("creative_structure","")
    if cs in NEEDS_VERIFY and r.get("success") and r.get("clickup_doc_page_id"):
        uuid = STRUCT_OPTS.get(cs)
        if uuid:
            ok = set_field(r["task_id"], FIELDS["creative_structure"], uuid)
            if ok: fixed += 1

print(f"Fix-up: {fixed} creative_structure fields corrected")
```

---

## STEP 8 — Final summary

```
✅ ClickUp Creative Data Fill — COMPLETE

List:     {LIST_ID}
Product:  {product_name}

Tasks processed:     X
Doc pages created:   X
Fields updated:      X
Skipped (no Drive):  X
Skipped (private):   X
Errors:              X

Doc: https://app.clickup.com/{workspace_id}/docs/{doc_id}
```

---

## Using on a NEW list (generic / non-preset product)

1. Provide the List ID and Doc ID
2. This skill auto-fetches all field IDs and dropdown UUIDs from the live API (Step 1b)
3. Map discovered field names to classification dimensions
4. If field names differ (e.g. "Ad Format" instead of "Creative Structure"), tell Claude the mapping
5. All dropdown UUIDs will be fetched fresh — no risk of stale IDs

Example invocations:
- *"run clickup creative data fill on list <your-list-id>, doc <your-doc-id>, your product"*
- *"fill creative fields for list 901600001234, doc 8xyz-5678, product Astro Rekha, angles: Love Match, Compatibility, Palm Reading, personas: Women 25-35 India"*
- *"do the creative pipeline on https://app.clickup.com/$CLICKUP_WORKSPACE_ID/v/l/<your-list-id>"*

---

## Error handling

| Error | Fix |
|---|---|
| **High bulk-fail rate (>15% of tasks) with `download_failed_or_private`** | Drive folders are likely shared only to the owner's Google account. Ask the owner to open each folder → Share → "Anyone with the link can view". Then re-run with `--retry-failed` — the pipeline re-fetches current Drive URLs from ClickUp and only retries the previously-failed set. This is the canonical recovery path. |
| **Drive URL contains `/drive/u/0/`, `/u/1/`, `/u/3/`** | Account-scoped URL. Even if it works today (owner is signed in that session), it will fail silently for automation later. Ask the owner to reshare with a clean `/drive/folders/<id>?usp=sharing` URL. STEP 1.5 preflight flags these as `account_scoped_ok` warnings. |
| **Folder exists but empty after download** | Media may have been deleted, or the folder contains only Google-native docs (Docs/Sheets) that gdown can't export. Check the folder manually. |
| Drive download returns HTML (~10KB) | Folder is private — STEP 1.5 preflight catches this upfront; fall-through: mark result `download_failed_or_private`, continue. |
| gdown `--dry-run` not supported | Remove flag, use folder listing without dry-run |
| 401 on ClickUp API | API key expired — check `$CLICKUP_API_KEY` in `~/.drims-classify.env` or ask user for a fresh one. |
| Dropdown UUID rejected (400) | Run fix-up pass in Step 7 with verified UUIDs |
| `success=false` in result | Skip ClickUp updates — classification failed |
| Empty `clickup_doc_page_id` | Skip field updates — doc creation failed |
| gdown `--folder` lists 0 files | Try direct file ID download instead |
| **KeyError: 'task_id' during writeback** | Agent wrote legacy keys. Run §2c `normalize_result()` on every `/tmp/cu_result_*.json` before writeback. Fixed by §2a schema lock on next run. |
| **`creative_modality` missing for video task** | Audio probe didn't run. Re-run §3b; if still missing, ask the user to confirm modality manually before writeback. |
| **Meta policy lint flags `FREE TODAY` headline** | Move the "FREE TODAY" text from headline → subtitle/caption before producing the variation. Surface the flag in the ClickUp comment. |
| **VO transcript confidence = "low"** | Means Whisper didn't run and captions were sparse. Flag in `verification_notes`; ask the production team to verify VO manually before scaling. |

---

## Prerequisites

```bash
ffmpeg -version        # must be installed (for frames + audio probe)
ffprobe -version       # ships with ffmpeg
pip3 install gdown requests
# Optional but strongly recommended for VO-driven ads:
pip3 install openai-whisper  # or: brew install whisper-cpp  → enables ground-truth VO transcripts
```

Google Drive folders must be set to "Anyone with the link can view".

---

## Changelog

- **2026-04-21** — v2.1: Added **STEP 1.5 Drive-access preflight** (parallel gdown test before dispatching agents) + new flags `--retry-failed` and `--skip-preflight` + auto-comment option on inaccessible tasks + error-handling entries for high-bulk-fail / account-scoped / empty-folder. Fixes the Canva Mastery run where 39/140 tasks failed silently mid-pipeline on private Drive folders; the owner had to manually list failures, re-share, then get told "re-run in incremental mode" — now the preflight surfaces this upfront and `--retry-failed` gives a dedicated recovery path.
- **2026-04-21** — v2: Added `creative_modality` field + audio probe (§3b) + VO/OSD transcript split (§3c) + 12-section brief template (§3d) + strict result schema (§2a) + validator (§2c) + policy lint (§3d.7). Fixes the AT-VID-001 misclassification bug (VO-driven treated as music-style) and the Apr 20 writeback crash (parallel agents writing `id` instead of `task_id`).
- **2026-04-20** — v1.1: Fixed `gdown --dry-run` flag (doesn't exist), added incremental mode, consolidation checkpoint, env loader.
- **2026-04-19** — v1.0: Merged `/clickup-creative-classifier` + `/clickup-creative-data-fill` into `/clickup-creative-pipeline`.
