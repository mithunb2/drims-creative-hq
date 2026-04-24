# Design System: DRIMS Creative HQ

## 1. Visual Theme & Atmosphere

A precision creative ops tool built for media buyers and creative directors who live inside it all day.
The atmosphere is **warm editorial meets operator cockpit** — like a well-designed physical studio
that also happens to run a trading terminal. Cream paper, terracotta ink, monospace data.

- **Density:** 7/10 — "Daily App Balanced" leaning toward cockpit. Data-dense but never suffocating.
- **Variance:** 5/10 — Confident asymmetry in section headers and dashboard stats. Tables stay grid-locked.
- **Motion:** 5/10 — Purposeful spring-physics micro-interactions. No decorative animation.

The interface should feel like it was designed by someone who has spent years in creative ops
and also spent years at a design agency. Every row, every cell, every status dot earns its place.

---

## 2. Color Palette & Roles

- **Warm Canvas** (`#faf9f5`) — Primary background. Slightly warm white, never pure.
- **Pure Paper** (`#ffffff`) — Card fills, table row hover, drawer panels.
- **Parchment** (`#f3f1e9`) — Secondary surface, tag backgrounds, muted fills.
- **Warm Border** (`#e8e5dc`) — Standard 1px structural lines. Never cold gray.
- **Border Hi** (`#d6d1c1`) — Emphasis borders, active cell outlines.
- **Deep Ink** (`#1a1814`) — Primary text. Near-black with warmth. Never pure `#000000`.
- **Ink Secondary** (`#585449`) — Supporting text, labels.
- **Ink Muted** (`#8f8a7c`) — Metadata, timestamps, column headers.
- **Ink Ghost** (`#b8b3a2`) — Placeholder text, empty states.
- **Terracotta** (`#c05336`) — SINGLE accent. CTAs, active tabs, focus rings, active filter chips. Never used decoratively.
- **Terracotta Deep** (`#a4401f`) — Button active/pressed state only.
- **Terracotta Soft** (`#f5e3da`) — Active chip backgrounds, subtle hover tints.

### Status Palette (semantic only — never decorative)
- **Scale** (`#35683f`) + soft (`#dcecd8`) — Top performer
- **Winner** (`#5e7557`) + soft (`#e4ebdc`) — Proven creative
- **Testing** (`#4f6780`) + soft (`#dde4ec`) — In evaluation
- **Approved** (`#7c5c2e`) + soft (`#f0e4cc`) — Ready queue
- **Ready to Launch** (`#3a6b8a`) + soft (`#d4e8f0`) — Queued
- **In Production** (`#c14400`) + soft (`#fbe0d0`) — Active work
- **Loser** (`#a83b28`) + soft (`#f2dad6`) — Killed
- **Untested** (`#8f8a7c`) + soft (`#f3f1e9`) — No data yet

### Banned Color Patterns
- No pure black (`#000000`) or pure white (`#ffffff`) as backgrounds
- No neon purple, electric blue, or oversaturated gradients
- No decorative gradient text on headings
- No multiple accent colors — terracotta is the only accent
- No cold gray surfaces that clash with the warm palette

---

## 3. Typography Rules

- **Primary Sans:** `Satoshi` (via fontshare) — Weights 400, 500, 600, 700. Warm geometric grotesk.
  Use for all UI text, buttons, labels, navigation, filter chips.
- **Data Mono:** `JetBrains Mono` — Weights 400, 500. For IDs (AT-001), counts, timestamps,
  status values in cells, metadata. Enable `font-feature-settings: "tnum" 1, "zero" 1`.
- **Editorial Serif:** `Instrument Serif` italic — For section headings, creative IDs in hero positions,
  empty state messaging. Never in data tables. Never in navigation.
- **Inter is BANNED** — Replace every instance with Satoshi.
- **Generic serifs are BANNED** — No Georgia, Times New Roman, Garamond.
- **Serif in tables is BANNED** — Tables use Satoshi for text, JetBrains Mono for data.

### Scale
- `10px` / `10.5px` — Column headers (uppercase, tracked), metadata tags
- `12px` / `12.5px` — Secondary labels, filter chips, nav tabs, badges
- `13px` — Default body / table row text
- `15px` — Section labels, important inline values
- `18px–22px` — Section titles (Instrument Serif italic in section headers)
- `28px–36px` — Dashboard KPI numbers (JetBrains Mono, tabular)

---

## 4. Component Stylings

### Masthead
- Sticky, 44px height. `background: rgba(250,249,245,0.92)` + `backdrop-filter: blur(16px) saturate(1.4)`.
- Brand mark: 22px squircle (`border-radius: 6px`) filled with terracotta gradient.
- Tab nav: text-only tabs, 12.5px Satoshi, active tab gets `border-bottom: 2px solid var(--accent)` + weight 600.
- Separator between brand and nav: 1px warm border, 16px tall.
- Right side: live sync dot (6px, animated pulse) + optional user avatar.
- The gradient accent line below the masthead (`linear-gradient(90deg, transparent, accent, transparent)`) at 0.3 opacity — subtle identity stripe.

### Buttons
- **Primary (accent):** `height: 28px`, `padding: 0 14px`, `border-radius: 5px`, `background: var(--accent)`, Satoshi 12.5px weight 500, `color: #fff`. Active: `transform: translateY(1px)`, `background: var(--accent-deep)`. Transition: `all 160ms cubic-bezier(0.32,0.72,0,1)`.
- **Ghost:** Same dimensions. `background: var(--paper)`, `border: 1px solid var(--line)`, `color: var(--ink-2)`. Hover: `border-color: var(--line-hi)`, `color: var(--ink)`.
- **Small:** `height: 24px`, `padding: 0 10px`, `font-size: 11.5px`.
- No outer glows. No neon shadows. Tactile `-1px` translate on active.

### Filter Chips
- `height: 28px`, `padding: 0 12px`, `border-radius: 14px`, `border: 1px solid var(--line)`.
- Active/set state: `background: var(--accent-soft)`, `border-color: var(--accent)`, `color: var(--accent)`.
- Hover: `border-color: var(--line-hi)`.
- The "More filters +" chip: ghost style, secondary position.
- Transition: `all 150ms cubic-bezier(0.32,0.72,0,1)`.

### Table Rows
- `height: 36px` — compact, never sprawling.
- Column headers: 10.5px Satoshi uppercase, letter-spacing 0.07em, color `var(--ink-3)`, `border-bottom: 1px solid var(--line)`.
- Row hover: `background: #f9f7f1` (barely perceptible warm tint).
- Row border: `border-bottom: 1px solid var(--line)` at 0.6 opacity.
- Status pills: `height: 20px`, `padding: 0 8px`, `border-radius: 10px`, 11px Satoshi weight 500.
- Funnel badges: `height: 18px`, `padding: 0 7px`, `border-radius: 3px`, 10.5px Satoshi uppercase, letter-spacing 0.05em.

### Cards (Dashboard KPIs)
- Double-Bezel architecture: outer shell `background: var(--paper-2)`, `border: 1px solid var(--line)`, `border-radius: 10px`, `padding: 3px`.
- Inner core: `background: var(--paper)`, `border-radius: 8px`, `padding: 16px 20px`.
- Shadow: `0 1px 2px rgba(26,24,20,0.04), 0 4px 12px rgba(26,24,20,0.05)`.
- KPI number: JetBrains Mono, 28–32px, `font-feature-settings: "tnum" 1`.
- Label: 10.5px Satoshi uppercase, letter-spacing 0.10em, color `var(--ink-3)`.
- Delta/trend: 11.5px JetBrains Mono, status-colored.

### Matrix Cells
- `min-height: 130px`, `padding: 12px`, `border-radius: 6px`, `border: 1px solid var(--line)`.
- Count number: Instrument Serif italic, 28px, color `var(--ink)`.
- Status bar: 4px height, proportional colored segments, `border-radius: 2px`.
- Status dots: 6px circles in status colors.
- Time tracking line: 11px JetBrains Mono, color `var(--ink-3)`.
- Empty cells: `border: 1px dashed var(--line-hi)`, `background: var(--paper-2)`.
- Hover: `border-color: var(--accent)`, `background: #fefcf9`.
- Hover action bar: slides up 28px from bottom, contains 2–3 small ghost buttons.

### Drawer / Side Panel
- `width: 380px`, slides from right. `background: var(--paper)`.
- Backdrop: `rgba(26,24,20,0.15)` blur overlay.
- Header: Instrument Serif italic title, close button (24px, ghost).
- View toggle (By Status/Funnel/Type): segmented control inside drawer, not on matrix header.
- Creative rows: 44px min-height, status pill right-aligned.

### Inputs / Selects
- `height: 28px`, `border: 1px solid var(--line)`, `border-radius: 5px`, `background: var(--paper)`.
- Focus: `border-color: var(--accent)`, `box-shadow: 0 0 0 3px var(--accent-soft)`.
- Font: 12.5px Satoshi.
- No floating labels. Label above, error below.

### Loading States
- Skeletal shimmer matching exact layout dimensions.
- Shimmer: `linear-gradient(90deg, var(--paper-2) 25%, var(--paper-3) 50%, var(--paper-2) 75%)` animated.
- No circular spinners.

---

## 5. Layout Principles

- **Max content width:** 1440px centered.
- **Panel padding:** `20px 24px` horizontal.
- **Section gap:** `16px` between major sections within a panel.
- **Table:** Full-width, no fixed widths except ID column (80px) and Actions (70px).
- **Matrix:** CSS Grid, `grid-template-columns: 140px repeat(N_personas, 1fr)`. Row header 140px fixed.
- **Dashboard grid:** Asymmetric — top row 5 KPIs equal width, below: 3-column with content variation.
- **Filter bar:** Two rows max. Primary (4 chips + search) always visible. Secondary expands on demand.
- **Sticky layers:** Masthead z:100, section header z:90, filter bar z:89. Strict z-index discipline.
- CSS Grid over Flexbox for multi-column layouts. No `calc()` percentage hacks.

---

## 6. Motion & Interaction

- **Default transition:** `all 150ms cubic-bezier(0.32,0.72,0,1)` — snappy but not jarring.
- **Larger motions (drawers, modals):** `all 280ms cubic-bezier(0.32,0.72,0,1)`.
- **Tab switches:** `opacity 0→1, translateY 4px→0` over `200ms`.
- **Row stagger:** `staggerIn` animation with `40ms` delay per row index.
- **Button active:** `translateY(1px)` — physical press feel.
- **Drawer slide:** `translateX(100%→0)` — hardware-accelerated.
- **Animate ONLY:** `transform` and `opacity`. Never `top`, `left`, `width`, `height`.
- **Status dot pulse:** Infinite `scale(1)→scale(1.3)→scale(1)` at 0.6 opacity at midpoint. 2.4s loop.
- **Live sync dot:** `box-shadow` radial pulse — `0 0 0 2px` → `0 0 0 6px rgba(green,0)`.
- **No spring bounce** in professional data interfaces — deceleration only.

---

## 7. Anti-Patterns (Banned)

- **Banned fonts:** Inter, Roboto, Arial, Open Sans, Helvetica, Georgia, Times New Roman
- **Replace Inter with:** Satoshi (already loaded in v2)
- **No pure black** (`#000000`) anywhere — use `#1a1814`
- **No neon glows** — no `box-shadow` with saturated color and large blur
- **No gradient text** on headings or large type
- **No oversaturated accents** — terracotta at ≤80% saturation only
- **No multiple accent colors** — one accent, used with discipline
- **No generic 3-equal-column card grids** — use asymmetric or varied sizing
- **No circular loading spinners** — skeletal loaders only
- **No custom mouse cursors**
- **No emojis** in UI chrome (tab labels, column headers, buttons)
- **No centered hero sections** — dashboard content left-aligned
- **No decorative gradients** — gradients used only for the identity stripe (0.3 opacity)
- **No thick drop shadows** — max `rgba(26,24,20,0.08)` at 12px blur
- **No warm/cool gray mixing** — stick to warm neutrals throughout
- **No serif fonts in tables, navigation, or buttons**
- **No AI copywriting clichés** ("Seamless", "Elevate", "Unleash", "Next-Gen")
- **No broken image links** — use initials avatars or SVG fallbacks
- **No `h-screen`** — use `min-height: 100dvh` for full-height elements
