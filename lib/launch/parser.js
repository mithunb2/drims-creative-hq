// parser.js — Meta launch Phase-1 parser (doc-extract -> launch plan -> budget preview). ZERO Meta
// writes. 1:1 port of drims-meta-launch/launch_parser.py. The .docx -> {paragraphs, tables}
// extraction happens in the browser (CDN JSZip); this module takes that structured text and does
// ALL parse/validate/budget/routing logic server-authoritative. The document is the SOLE source of
// truth for budget + target account — nothing about money is hardcoded. Store-agnostic: routing is
// 100% registry.js-driven; zero store names live here.
import { accountFor } from './registry.js';
import { classifyAsl, aslAllowsLaunch } from './asl.js';

export class ParseError extends Error {}

const AF_KNOWN = new Set(['CreatorPOV+BookReveal', 'Faceless+BookBroll', 'Faceless+NatureBroll']);
const REQUIRED_NAME_KEYS = ['f', 'af', 'm', 'h', 'p', 'len', 'o', 'lp', 'a'];
const CONFIG_REQUIRED = ['Store', 'Budget Level', 'Budget Type', 'Budget Amount (USD)',
  'Launch Spend Cap (USD)', 'Run Length (days)'];

/** Video k -> ad number (026..035). Video 1 = 026, so ad = 25 + k. */
export function videoToAd(n) {
  return String(25 + n).padStart(3, '0');
}

// ── strict value parsing (kills the "~$15" ambiguity) ─────────────────────────────
export function parseMoney(raw) {
  const s = (raw || '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new ParseError(`budget value must be a bare number (got '${raw}'; no $, ~, commas)`);
  }
  return parseFloat(s);
}

export function parseIntStrict(raw) {
  const s = (raw || '').trim();
  if (!/^\d+$/.test(s)) throw new ParseError(`expected an integer (got '${raw}')`);
  return parseInt(s, 10);
}

// ── LAUNCH CONFIG table (the ONLY source for budget + routing) ────────────────────
export function parseLaunchConfig(tables) {
  for (const rows of tables) {
    const keys = new Set((rows || []).map((r) => (r && r[0] ? r[0].trim() : '')));
    if (keys.has('Store') && [...keys].some((k) => k.includes('Budget'))) {
      const cfg = {};
      for (const r of rows) {
        if (r.length >= 2 && r[0].trim() && r[0].trim().toLowerCase() !== 'field') {
          cfg[r[0].trim()] = r[1].trim();
        }
      }
      return cfg;
    }
  }
  return {};
}

// ── Quick-reference table (authoritative ad -> ad-set map) ────────────────────────
export function parseQuickReference(tables) {
  for (const rows of tables) {
    if (!rows || !rows.length) continue;
    const hdr = rows[0].map((c) => c.toLowerCase());
    if (hdr.includes('ad #') && hdr.includes('ad set') && hdr.includes('video file')) {
      const idx = {};
      rows[0].forEach((c, i) => { idx[c.toLowerCase()] = i; });
      const out = {};
      for (const r of rows.slice(1)) {
        if (r.length < rows[0].length) continue;
        const ad = r[idx['ad #']].trim();
        const adsetRaw = r[idx['ad set']].trim();       // e.g. "AS1 Creator-POV"
        const m = adsetRaw.match(/(AS\d+)\s*(.*)/);
        const angleIdx = idx['angle (cluster)'] ?? idx['angle'];
        out[ad] = {
          video_file: r[idx['video file']].trim(),
          ad_set: m ? m[1] : adsetRaw,
          ad_set_name: m ? m[2].trim() : '',
          angle: angleIdx != null ? (r[angleIdx] || '').trim() : '',
          length: idx['length'] != null ? (r[idx['length']] || '').trim() : '',
          hook: idx['hook'] != null ? (r[idx['hook']] || '').trim() : '',
        };
      }
      return out;
    }
  }
  return {};
}

// ── Naming string ─────────────────────────────────────────────────────────────────
export function parseNameString(name) {
  const parts = (name || '').split('|').map((p) => p.trim());
  const errors = [];
  if (parts.length < 9) {
    errors.push(`name string has too few segments (${parts.length})`);
    return [{}, errors];
  }
  const head = parts.slice(0, 6);
  const kv = {}; const extras = [];
  for (const tok of parts.slice(6)) {
    const m = tok.match(/^([a-zA-Z]{1,4}):(.*)$/);
    if (m) kv[m[1].toLowerCase()] = m[2].trim();
    else extras.push(tok);
  }
  const tokens = {
    DA: head[0], date: head[1], funnel_stage: head[2],
    campaign_label: head[3], row: head[4], round: head[5],
    ...kv,
    version: extras[0] || '',
    cta: extras.length > 1 ? extras[1] : '',
  };
  for (const k of REQUIRED_NAME_KEYS) {
    if (!tokens[k]) errors.push(`missing required token ${k}:`);
  }
  return [tokens, errors];
}

// ── Ad blocks (NAME + AD COPY) ────────────────────────────────────────────────────
const AD_HDR = /^AD\s+(\d+)\s*[-–]\s*(\S+\.mp4)/i;
const SECTION_HDR = /^(AD SET|LAUNCH SEQUENCE|FIELD KEY|VERIFICATION|COMPANION|QUICK)/i;

const TESTING_HDR = /^Testing:/i;

export function parseAdBlocks(paragraphs) {
  const ads = [];
  let cur = null; let mode = null;
  for (const para of paragraphs) {
    const m = para.match(AD_HDR);
    if (m) {
      if (cur) ads.push(cur);
      // script[] captures the EDITOR half (everything between the AD header and NAME:/AD COPY:);
      // test_label captures a "Testing:" line (the buyer's stated test) wherever it appears.
      cur = { ad_number: m[1], video_file: m[2], name_string: '', ad_copy: [], script: [], test_label: '' };
      mode = 'script';   // pre-NAME lines belong to the script half
      continue;
    }
    if (cur === null) continue;
    if (para.startsWith('NAME:')) {
      cur.name_string = para.slice('NAME:'.length).trim();
      mode = 'name';
    } else if (para.startsWith('AD COPY:')) {
      mode = 'copy';
      const rest = para.slice('AD COPY:'.length).trim();
      if (rest) cur.ad_copy.push(rest);
    } else if (TESTING_HDR.test(para)) {
      cur.test_label = para.replace(TESTING_HDR, '').trim();   // launch metadata, not ad copy
    } else if (SECTION_HDR.test(para)) {
      ads.push(cur); cur = null; mode = null;
    } else if (mode === 'copy') {
      cur.ad_copy.push(para);
    } else if (mode === 'script') {
      cur.script.push(para);
    }
  }
  if (cur) ads.push(cur);
  for (const a of ads) {
    a.ad_copy = a.ad_copy.join('\n').trim();
    // Strip an optional leading "SCRIPT:" label; keep the buyer's words otherwise verbatim.
    a.script = a.script.join('\n').replace(/^\s*SCRIPT:\s*/i, '').trim();
  }
  return ads;
}

// ── Launch sequence (which ads go live week 1) ────────────────────────────────────
export function parseLaunchSequence(paragraphs) {
  const week1 = new Set();
  let grab = false;
  for (const para of paragraphs) {
    const u = para.toUpperCase();
    if (u.startsWith('WEEK 1')) grab = true;
    else if (u.startsWith('WEEK 2') || u.startsWith('WEEK 3')) grab = false;
    if (grab) {
      for (const m of para.matchAll(/\((\d{3})\)/g)) week1.add(m[1]);
    }
  }
  return week1;
}

// ── QA flags ──────────────────────────────────────────────────────────────────────
export function parseQaFlags(paragraphs) {
  const flags = [];
  for (const para of paragraphs) {
    const up = para.toUpperCase();
    if (up.includes('CRITICAL FLAG')) {
      for (const m of up.matchAll(/VIDEO\s+(\d+)/g)) {
        flags.push({ severity: 'CRITICAL', ad_number: videoToAd(parseInt(m[1], 10)),
          video: parseInt(m[1], 10), requires_ack: true, text: para.slice(0, 200) });
      }
    } else if (/\bFLAG\b/.test(up) && up.includes('VIDEO') && !up.includes('AUDIO FLAG')) {
      for (const m of up.matchAll(/VIDEO\s+(\d+)/g)) {
        flags.push({ severity: 'FLAG', ad_number: videoToAd(parseInt(m[1], 10)),
          video: parseInt(m[1], 10), requires_ack: true, text: para.slice(0, 200) });
      }
    } else if (up.includes('AUDIO FLAG')) {
      flags.push({ severity: 'FLAG', ad_number: 'ALL', video: null, requires_ack: true,
        text: 'Confirm all VO is real human voice (not AI) before launch.' });
    }
  }
  return flags;
}

// ── Budget (100% from the doc's own numbers) ──────────────────────────────────────
export function computeBudget(config, activeAdSets, totalAdSets) {
  const level = (config['Budget Level'] || '').trim();
  const btype = (config['Budget Type'] || '').trim();
  const amount = parseMoney(config['Budget Amount (USD)'] || '');
  const cap = parseMoney(config['Launch Spend Cap (USD)'] || '');
  const runDays = parseIntStrict(config['Run Length (days)'] || '');
  const n = level === 'ad_set' ? activeAdSets : 1;
  const dailyTotal = amount * n;
  const weeklyTotal = dailyTotal * 7;
  const runTotal = dailyTotal * runDays;
  return {
    level, type: btype, amount, n_active_ad_sets: n,
    daily_total: dailyTotal, weekly_total: weeklyTotal,
    run_days: runDays, run_total_estimate: runTotal,
    launch_spend_cap: cap,
    arithmetic: `$${amount.toFixed(2)} x ${n} active ad set(s) = $${dailyTotal.toFixed(2)}/day `
      + `-> $${weeklyTotal.toFixed(2)}/week -> ~$${runTotal.toFixed(2)} over ${runDays} days`,
  };
}

// ── Orchestrator: extracted {paragraphs, tables} -> full plan + validation ────────
/** @param {{paragraphs:string[], tables:string[][][]}} extracted
 *  @param {object} [opts] - reg (injected registry), aslFields (LIVE Meta read; null tokenless -> BLOCK) */
export function parseLaunchDoc(extracted, opts = {}) {
  const { paragraphs = [], tables = [] } = extracted || {};
  const reg = opts.reg || null;
  const aslFields = opts.aslFields === undefined ? null : opts.aslFields;

  const config = parseLaunchConfig(tables);
  const manifest = parseQuickReference(tables);
  const adBlocks = parseAdBlocks(paragraphs);
  const week1 = parseLaunchSequence(paragraphs);
  const flags = parseQaFlags(paragraphs);
  const storeName = config.Store || '';
  const routing = storeName ? accountFor(storeName, reg) : { ok: false, record: null, account_id: null };

  const blockers = []; const warnings = [];

  for (const f of CONFIG_REQUIRED) {
    if (!config[f]) blockers.push(`LAUNCH CONFIG missing required field: ${f}`);
  }
  for (const f of ['Budget Amount (USD)', 'Launch Spend Cap (USD)']) {
    if (config[f]) {
      try { parseMoney(config[f]); } catch (e) { blockers.push(`${f}: ${e.message}`); }
    }
  }
  if (config['Run Length (days)']) {
    try { parseIntStrict(config['Run Length (days)']); } catch (e) { blockers.push(`Run Length (days): ${e.message}`); }
  }

  const record = routing.record;
  const accountId = routing.account_id;
  if (!storeName) blockers.push('target account not identified: LAUNCH CONFIG has no Store');
  else if (record === null) blockers.push(`target account not identified: Store '${storeName}' is not in the registry`);
  else if (!accountId) blockers.push(`target account not identified: ${routing.reason}`);
  else {
    const docAct = (config['Ad Account ID'] || '').trim();
    if (docAct && docAct !== accountId) {
      blockers.push(`Ad Account cross-check FAILED: doc says ${docAct}, Store resolves to ${accountId} (BM ${record.business_id})`);
    }
  }

  const ads = [];
  for (const a of adBlocks) {
    const [tokens, errs] = parseNameString(a.name_string);
    for (const e of errs) blockers.push(`AD ${a.ad_number} name string: ${e}`);
    const af = tokens.af || '';
    if (af && !AF_KNOWN.has(af)) warnings.push(`AD ${a.ad_number}: af:${af} not in known set ${JSON.stringify([...AF_KNOWN].sort())}`);
    const mrow = manifest[a.ad_number] || {};
    const lenTok = (tokens.len || '').replace(/\D/g, '');
    const lenTab = (mrow.length || '').replace(/\D/g, '');
    if (lenTok && lenTab && lenTok !== lenTab) warnings.push(`AD ${a.ad_number}: len:${tokens.len} disagrees with table ${mrow.length}`);
    if (!(a.ad_number in manifest)) blockers.push(`AD ${a.ad_number} present in copy but missing from quick-reference table`);
    ads.push({ ...a, tokens, ad_set: mrow.ad_set || '?', angle: mrow.angle || '', hook: mrow.hook || '',
      launch_week: week1.has(a.ad_number) ? 1 : 'staged' });
  }
  const copyIds = new Set(adBlocks.map((a) => a.ad_number));
  for (const adId of Object.keys(manifest)) {
    if (!copyIds.has(adId)) blockers.push(`AD ${adId} in quick-reference table but missing an AD COPY block`);
  }

  const adSets = {};
  for (const a of ads) { (adSets[a.ad_set] ||= []).push(a.ad_number); }
  for (const k of Object.keys(adSets)) adSets[k].sort();
  const activeSets = [...new Set(ads.filter((a) => a.launch_week === 1).map((a) => a.ad_set))].sort();

  let budget = null;
  if (!blockers.some((b) => b.toLowerCase().includes('budget') || b.toLowerCase().includes('run length'))) {
    try {
      budget = computeBudget(config, activeSets.length, Object.keys(adSets).length);
      if (budget.launch_spend_cap < budget.run_total_estimate) {
        warnings.push(`Launch Spend Cap $${budget.launch_spend_cap.toFixed(2)} < estimated run spend $${budget.run_total_estimate.toFixed(2)} — cap may throttle delivery`);
      }
    } catch (e) { blockers.push(`budget: ${e.message}`); }
  }

  for (const fl of flags) {
    fl.in_week1 = week1.has(fl.ad_number);
    fl.blocks_activation = fl.severity === 'CRITICAL' && fl.in_week1;
  }

  // ASL gate: tokenless aslFields=null -> classifyAsl returns 'unknown' -> fail-closed BLOCK.
  const committed = budget ? budget.launch_spend_cap : 0;
  const aslGate = classifyAsl(aslFields, committed);
  const criticalBlocks = flags.filter((f) => f.blocks_activation).map((f) => f.ad_number);

  const structurallyOk = blockers.length === 0;
  const aslOk = aslAllowsLaunch(aslGate);          // false when unknown/none
  const qaOk = criticalBlocks.length === 0;

  return {
    config, store: storeName, store_record: record, account_id: accountId,
    campaign: {
      label: config.campaign_label || (ads[0] ? ads[0].tokens.campaign_label : ''),
      funnel_stage: config['Funnel Stage'] || (ads[0] ? ads[0].tokens.funnel_stage : ''),
      objective: 'OUTCOME_SALES',
    },
    ads, ad_sets: adSets, active_ad_sets: activeSets,
    week1_active: [...week1].sort(), flags, budget,
    blockers, warnings,
    ok: structurallyOk,
    asl_gate: aslGate,
    // The single launch-permission verdict the UI's Submit obeys. Every clause must be true.
    launch_permission: {
      allowed: structurallyOk && aslOk && qaOk,
      structurally_ok: structurallyOk,
      asl_ok: aslOk,
      qa_ok: qaOk,
      critical_week1_ads: criticalBlocks,
      asl_state: aslGate.state,
      reason: !structurallyOk ? 'structural blockers present'
        : !aslOk ? `ASL gate ${aslGate.state} — ${aslGate.message}`
          : !qaOk ? `unacknowledged CRITICAL week-1 QA flag(s): ${criticalBlocks.join(', ')}`
            : 'all gates clear (still requires META_LAUNCH_ALLOW_LIVE_WRITES + human submit)',
    },
  };
}

// ── Dual-half SPLIT model: one doc -> N per-script entries (editor half + held launch half) ────────
// Reuses parseLaunchDoc entirely (routing, budget, QA flags, ad-block parsing) then reshapes into a
// split job: doc-level {store, editor, campaign_config} + N entries each carrying its SCRIPT (editor
// half, verbatim) and its LAUNCH half (ad copy + Meta config, held verbatim for reuse-not-regenerate).
// N-AGNOSTIC: entries = however many ad blocks the doc contains (1, 3, 20, 50+). No fixed count.
// The editor is named IN THE DOC (LAUNCH CONFIG "Editor" field); name->assignee resolution happens
// downstream (the intake worker / Vercel preview via ClickUp member lookup). Here we only flag its
// ABSENCE as a blocker — we never guess an editor.
export function parseSplitDoc(extracted, opts = {}) {
  const plan = parseLaunchDoc(extracted, opts);
  const config = plan.config || {};
  const blockers = [...plan.blockers];
  const warnings = [...plan.warnings];

  const editorName = (config.Editor || '').trim();
  if (!editorName) {
    blockers.push('No Editor named in the doc — add an "Editor" field to LAUNCH CONFIG so tasks can be assigned.');
  }

  const entries = plan.ads.map((a, i) => {
    if (!a.script || !a.script.trim()) {
      blockers.push(`Entry AD ${a.ad_number}: no SCRIPT above the launch data — nothing for the editor to build.`);
    }
    if (!a.ad_copy || !a.ad_copy.trim()) {
      warnings.push(`Entry AD ${a.ad_number}: empty AD COPY.`);
    }
    if (!a.test_label) {
      warnings.push(`Entry AD ${a.ad_number}: no "Testing:" label — Production name will fall back to task + person only.`);
    }
    return {
      entry_index: i,
      ad_number: a.ad_number,
      video_file: a.video_file,        // the pairing key: this script produces it; its ad copy launches it
      script: a.script || '',          // EDITOR half, verbatim
      test_label: a.test_label || '',
      launch_half: {                   // BUYER half — held verbatim, reused (never regenerated)
        ad_copy: a.ad_copy || '',
        name_string: a.name_string || '',
        ad_set: a.ad_set || '',        // Phase-1 ad-set = buyer-specified (from quick-ref table)
        tokens: a.tokens || {},
        test_label: a.test_label || '',
        video_file: a.video_file,
      },
    };
  });

  return {
    store: plan.store,
    store_record: plan.store_record,
    account_id: plan.account_id,
    editor_name: editorName,           // resolved to a ClickUp assignee downstream; absence = blocker above
    campaign_config: config,           // doc-level LAUNCH CONFIG (budget/account/etc.) — held once per job
    budget: plan.budget,
    entries,
    count: entries.length,             // the ACTUAL number parsed — surfaced in the preview
    blockers,
    warnings,
    ok: blockers.length === 0,
  };
}
