#!/usr/bin/env python3
"""
fb_ad_classifier.py
───────────────────
Background pipeline: Facebook Ads Library URL → video download → frame extraction

Usage:
    python3 fb_ad_classifier.py <ad_id_or_url>

Examples:
    python3 fb_ad_classifier.py 1984581118871631
    python3 fb_ad_classifier.py "https://www.facebook.com/ads/library/?id=1984581118871631"

Output:
    /tmp/fb_ad_<ID>/frame_001.jpg ... frame_NNN.jpg
    Prints ad metadata (copy, CTA, format, video URL) to stdout
    Frames are left on disk for Claude to read and classify visually

Requirements:
    pip3 install playwright requests
    python3 -m playwright install chromium
    brew install ffmpeg   (or: apt-get install ffmpeg)
"""

import asyncio
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
FRAMES_PER_VIDEO = 8          # max frames to extract
FRAME_INTERVAL_SEC = 3        # 1 frame every N seconds
FRAME_WIDTH_PX = 720          # resize width (height auto)
OUTPUT_BASE = "/tmp"          # frames saved to /tmp/fb_ad_<ID>/
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


# ── Helpers ──────────────────────────────────────────────────────────────────
def extract_ad_id(input_str: str) -> str:
    """Accept raw ID or full URL, return just the numeric ID string."""
    m = re.search(r'[?&]id=(\d+)', input_str)
    if m:
        return m.group(1)
    if re.fullmatch(r'\d+', input_str.strip()):
        return input_str.strip()
    raise ValueError(f"Cannot extract ad ID from: {input_str!r}")


def unescape_fb_url(s: str) -> str:
    """Fix \\/ and HTML-encoded % in URLs embedded in Facebook page HTML."""
    return s.replace('\\/', '/').replace('%25', '%')


def decode_unicode(s: str) -> str:
    """Decode \\uXXXX sequences including surrogate pairs (emoji) from Facebook JSON."""
    if not s:
        return s
    # Handle surrogate pairs first: \\uD83D\\uDD2E → 🔮
    def replace_surrogates(m):
        high = int(m.group(1), 16)
        low  = int(m.group(2), 16)
        code = ((high - 0xD800) << 10) + (low - 0xDC00) + 0x10000
        return chr(code)
    result = re.sub(r'\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})',
                    replace_surrogates, s)
    # Then decode remaining \\uXXXX
    result = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), result)
    return result


# ── Step 1: Fetch ad JSON from page ──────────────────────────────────────────
async def fetch_ad_snapshot(ad_id: str) -> dict:
    """
    Use Playwright headless to load the Ads Library page and extract the
    embedded JSON snapshot for the target ad.
    Returns dict with keys: video_hd_url, video_sd_url, video_preview_image_url,
                            body_text, cta_text, cta_type, title, caption, display_format
    """
    from playwright.async_api import async_playwright

    url = f"https://www.facebook.com/ads/library/?id={ad_id}"
    print(f"[1/4] Loading page (headless): {url}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(user_agent=USER_AGENT)
        page = await context.new_page()

        await page.goto(url, wait_until="networkidle", timeout=30000)
        content = await page.content()
        await browser.close()

    # Locate the ad's JSON block — properly bounded to this ad's object only
    marker = f'"ad_archive_id":"{ad_id}"'
    idx = content.find(marker)
    if idx == -1:
        raise RuntimeError(
            f"Ad ID {ad_id} not found in page. "
            "The ad may be inactive or the page may require login."
        )

    # Find the enclosing JSON object by scanning for matching braces
    # This prevents bleeding into neighboring ads on collated pages
    start = idx
    brace_count = 0
    for i in range(idx, max(idx - 5000, 0), -1):
        if content[i] == '}':
            brace_count += 1
        if content[i] == '{':
            brace_count -= 1
            if brace_count < 0:
                start = i
                break

    end = idx
    brace_count = 0
    for i in range(start, min(start + 20000, len(content))):
        if content[i] == '{':
            brace_count += 1
        if content[i] == '}':
            brace_count -= 1
            if brace_count == 0:
                end = i + 1
                break

    chunk = content[start:end]

    def _find(pattern, text=chunk):
        m = re.search(pattern, text)
        return unescape_fb_url(m.group(1)) if m else None

    snapshot = {
        "ad_id":              ad_id,
        "video_hd_url":       _find(r'"video_hd_url":"(https:\\/\\/video[^"]+\.mp4[^"]*)"'),
        "video_sd_url":       _find(r'"video_sd_url":"(https:\\/\\/video[^"]+\.mp4[^"]*)"'),
        "video_preview_url":  _find(r'"video_preview_image_url":"(https:\\/\\/scontent[^"]+\.jpg[^"]*)"'),
        "image_url":          _find(r'"original_image_url":"(https:\\/\\/scontent[^"]+)"'),
        "body_text":          _find(r'"body":\{"text":"([^"]+)"'),
        "title":              _find(r'"title":"([^"]+)"'),
        "cta_text":           _find(r'"cta_text":"([^"]+)"'),
        "cta_type":           _find(r'"cta_type":"([^"]+)"'),
        "caption":            _find(r'"caption":"([^"]+)"'),
        "display_format":     _find(r'"display_format":"([^"]+)"'),
        "link_url":           _find(r'"link_url":"(https?:\\/\\/[^"]+)"'),
        "link_description":   _find(r'"link_description":"([^"]+)"'),
        "page_name":          _find(r'"page_name":"([^"]+)"'),
        "collation_count":    _find(r'"collation_count":(\d+)'),
    }

    return snapshot


# ── Step 2: Download video ────────────────────────────────────────────────────
def download_video(url: str, dest: str) -> int:
    """Download video from CDN URL. Returns file size in bytes."""
    print(f"[2/4] Downloading video...")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=90) as resp, open(dest, "wb") as f:
        f.write(resp.read())
    size = os.path.getsize(dest)
    print(f"      {size / 1024:.0f} KB saved to {dest}")
    return size


# ── Step 3: Extract frames ────────────────────────────────────────────────────
def extract_frames(video_path: str, output_dir: str) -> list[str]:
    """
    Extract frames at FRAME_INTERVAL_SEC intervals using ffmpeg.
    Returns sorted list of frame file paths.
    """
    print(f"[3/4] Extracting frames (1 every {FRAME_INTERVAL_SEC}s)...")
    os.makedirs(output_dir, exist_ok=True)
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", video_path,
            "-vf", f"fps=1/{FRAME_INTERVAL_SEC},scale={FRAME_WIDTH_PX}:-1",
            "-q:v", "2",
            os.path.join(output_dir, "frame_%03d.jpg"),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"      ffmpeg stderr: {result.stderr[-300:]}")

    frames = sorted(
        str(Path(output_dir) / f)
        for f in os.listdir(output_dir)
        if f.startswith("frame_") and f.endswith(".jpg")
    )

    # Keep only first FRAMES_PER_VIDEO
    if len(frames) > FRAMES_PER_VIDEO:
        for extra in frames[FRAMES_PER_VIDEO:]:
            os.remove(extra)
        frames = frames[:FRAMES_PER_VIDEO]

    print(f"      {len(frames)} frames extracted")
    return frames


# ── Step 4: Print classification prompt ──────────────────────────────────────
def print_classification_prompt(snapshot: dict, frames: list[str]):
    """Print metadata and frame paths for Claude to read and classify."""
    print("\n" + "═" * 60)
    print("  AD METADATA")
    print("═" * 60)
    print(f"  Ad ID       : {snapshot['ad_id']}")
    print(f"  Page        : {snapshot.get('page_name', '?')}")
    print(f"  Format      : {snapshot.get('display_format', '?')}")
    print(f"  Body        : {decode_unicode(snapshot.get('body_text') or '–')[:120]}")
    print(f"  Title       : {decode_unicode(snapshot.get('title') or '–')}")
    print(f"  Description : {decode_unicode(snapshot.get('link_description') or '–')}")
    print(f"  CTA         : {decode_unicode(snapshot.get('cta_text') or '?')} ({snapshot.get('cta_type','?')})")
    print(f"  Landing     : {snapshot.get('link_url', '–')}")
    print(f"  Collations  : {snapshot.get('collation_count', '1')}")
    print()
    print("  FRAMES FOR VISUAL CLASSIFICATION")
    print("─" * 60)
    for f in frames:
        print(f"  {f}")
    print()
    print("  CLASSIFICATION DIMENSIONS")
    print("─" * 60)
    print("  Photo/Video | Hook Type | Creative Structure | Production Style")
    print("  Funnel Type | Persona   | Angle              | Creative Hypothesis")
    print("═" * 60)
    print()
    print("  → Pass frame paths to Claude Read tool to classify visually.")
    print()


# ── Main ──────────────────────────────────────────────────────────────────────
async def run(input_str: str):
    ad_id = extract_ad_id(input_str)
    output_dir = os.path.join(OUTPUT_BASE, f"fb_ad_{ad_id}")
    video_path = os.path.join(OUTPUT_BASE, f"fb_ad_{ad_id}.mp4")

    # Clean any previous run
    if os.path.exists(output_dir):
        import shutil
        shutil.rmtree(output_dir)

    # Step 1: Fetch snapshot JSON
    snapshot = await fetch_ad_snapshot(ad_id)

    # Determine media type
    video_url = snapshot.get("video_hd_url") or snapshot.get("video_sd_url")
    is_video = bool(video_url)

    print(f"      Format: {snapshot.get('display_format', '?')}")
    print(f"      Page  : {snapshot.get('page_name', '?')}")
    print(f"      Body  : {(snapshot.get('body_text') or '')[:80]}")

    frames = []

    if is_video:
        # Step 2: Download
        download_video(video_url, video_path)

        # Step 3: Extract frames
        frames = extract_frames(video_path, output_dir)

        # Clean up video file immediately
        os.remove(video_path)
        print(f"      Video deleted — frames kept at {output_dir}/")

    elif snapshot.get("image_url"):
        # Photo ad — download the image directly
        print("[2/4] Downloading image...")
        os.makedirs(output_dir, exist_ok=True)
        img_path = os.path.join(output_dir, "frame_001.jpg")
        req = urllib.request.Request(
            snapshot["image_url"], headers={"User-Agent": USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=30) as resp, open(img_path, "wb") as f:
            f.write(resp.read())
        frames = [img_path]
        print(f"      Image saved: {img_path}")

    else:
        print("⚠ No video or image URL found in snapshot. Manual review needed.")

    # Step 4: Summary
    print("[4/4] Done.")
    print_classification_prompt(snapshot, frames)

    # Save snapshot JSON for reference
    meta_path = os.path.join(output_dir, "snapshot.json")
    if frames:  # only if we have something in the dir
        with open(meta_path, "w") as f:
            json.dump(snapshot, f, indent=2, ensure_ascii=False)
        print(f"  Metadata saved: {meta_path}")

    return snapshot, frames


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    asyncio.run(run(sys.argv[1]))
