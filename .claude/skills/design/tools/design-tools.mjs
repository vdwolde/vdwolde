#!/usr/bin/env node
// design-tools.mjs -- deterministic helpers for the /design skill. Zero dependencies. Read-only:
// it prints to stdout and never writes a project file.
//
//   node design-tools.mjs contrast <fg> <bg> [<fg> <bg> ...]   WCAG ratio per pair
//   node design-tools.mjs oklch <colour>                       hex / rgb() / oklch() -> oklch(L C H)
//   node design-tools.mjs hex <colour>                         any colour -> #rrggbb (gamut-mapped)
//   node design-tools.mjs ramp <colour> [--steps 11]           lightness ramp, same hue, chroma tapered at the ends
//   node design-tools.mjs retint <colour> <targetColour>       keep L and C of colour, take hue of target
//   node design-tools.mjs inventory <path...> [--top 15] [--delta 0.03] [--json]
//   node design-tools.mjs --self-test
//
// Colours accepted: #rgb #rrggbb #rrggbbaa rgb(r g b) rgb(r, g, b) color(srgb r g b) oklch(L C H) (L as 0-1 or %).
// Alpha is ignored: composite a translucent colour over its background yourself before checking contrast.
// Run with `node` (an already-trusted host process on this machine), never as a compiled binary.
// Inventory limits: colour, font-size, radius, shadow, duration and z-index literals are found in CSS,
// markup, JS/TS and XAML; duplicate/unused token analysis covers CSS custom properties only. Results are
// candidates to read, not verdicts.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// ---------- colour maths (Ottosson oklab, sRGB, WCAG 2.x) ----------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const oklabToOklch = ([L, a, b]) => {
  const C = Math.hypot(a, b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, C < 1e-4 ? 0 : H];
};
const oklchToOklab = ([L, C, H]) => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];

const inGamut = (lin) => lin.every((v) => v >= -0.0005 && v <= 1.0005);

// Reduce chroma (keeping L and H) until the colour fits in sRGB.
function gamutMapOklch([L, C, H]) {
  if (inGamut(oklabToLinear(oklchToOklab([L, C, H])))) return { lch: [L, C, H], mapped: false };
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(oklchToOklab([L, mid, H])))) lo = mid;
    else hi = mid;
  }
  return { lch: [L, lo, H], mapped: true };
}

function oklchToRgb255(lch) {
  const { lch: g, mapped } = gamutMapOklch(lch);
  const lin = oklabToLinear(oklchToOklab(g)).map(clamp01);
  return { rgb: lin.map((v) => Math.round(toGamma(v) * 255)), mapped };
}

const rgb255ToHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
const rgb255ToOklch = (rgb) => oklabToOklch(linearToOklab(rgb.map((v) => toLinear(v / 255))));

// Parse any accepted colour string -> { rgb: [0-255 x3] | null, lch: [L,C,H] } (rgb is gamut-mapped for oklch input).
function parseColour(input) {
  const s = String(input).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error(`bad hex colour: ${input}`);
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return { rgb, lch: rgb255ToOklch(rgb) };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) {
    const rgb = [m[1], m[2], m[3]].map((v) => Math.round(Math.min(255, Math.max(0, Number(v)))));
    return { rgb, lch: rgb255ToOklch(rgb) };
  }
  // getComputedStyle in Chrome returns color(srgb r g b) for colour-mix() and some modern colours
  m = s.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (m) {
    const rgb = [m[1], m[2], m[3]].map((v) => Math.round(clamp01(Number(v)) * 255));
    return { rgb, lch: rgb255ToOklch(rgb) };
  }
  m = s.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?/);
  if (m) {
    const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
    const lch = [L, Number(m[3]), Number(m[4])];
    return { rgb: oklchToRgb255(lch).rgb, lch };
  }
  throw new Error(`unrecognised colour: ${input}`);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => toLinear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(rgbA, rgbB) {
  const a = luminance(rgbA);
  const b = luminance(rgbB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const fmtLch = ([L, C, H]) => `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;

function deltaE(lchA, lchB) {
  const [L1, a1, b1] = oklchToOklab(lchA);
  const [L2, a2, b2] = oklchToOklab(lchB);
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2);
}

// ---------- commands: contrast / oklch / hex / ramp / retint ----------

function cmdContrast(args) {
  if (args.length < 2 || args.length % 2) throw new Error('contrast needs pairs: <fg> <bg> [<fg> <bg> ...]');
  const rows = [];
  for (let i = 0; i < args.length; i += 2) {
    const fg = parseColour(args[i]);
    const bg = parseColour(args[i + 1]);
    const ratio = contrastRatio(fg.rgb, bg.rgb);
    rows.push(
      `${args[i]} on ${args[i + 1]}  ${ratio.toFixed(2)}:1  text(4.5) ${ratio >= 4.5 ? 'pass' : 'FAIL'}  ` +
        `large/UI(3) ${ratio >= 3 ? 'pass' : 'FAIL'}  AAA(7) ${ratio >= 7 ? 'pass' : 'no'}`,
    );
  }
  return rows.join('\n');
}

function cmdOklch(args) {
  const c = parseColour(args[0]);
  return fmtLch(c.lch);
}

function cmdHex(args) {
  const c = parseColour(args[0]);
  const { rgb, mapped } = oklchToRgb255(c.lch);
  return rgb255ToHex(rgb) + (mapped ? '   (chroma reduced to fit sRGB)' : '');
}

function cmdRamp(args) {
  const stepsIdx = args.indexOf('--steps');
  const steps = stepsIdx >= 0 ? Number(args[stepsIdx + 1]) : 11;
  const c = parseColour(args[0]);
  const [, C, H] = c.lch;
  const labels = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  const out = [`ramp from ${args[0]}  ${fmtLch(c.lch)}  (hue kept; chroma tapers toward the light and dark ends and is reduced where sRGB cannot hold it)`];
  for (let i = 0; i < steps; i++) {
    const L = 0.97 - (i * (0.97 - 0.15)) / (steps - 1);
    const t = Math.abs(L - 0.62) / 0.38; // chroma peaks mid-ramp and tapers toward the light and dark ends
    const { rgb, mapped } = oklchToRgb255([L, C * Math.max(0.15, 1 - 0.85 * t * t), H]);
    const lch = rgb255ToOklch(rgb);
    const label = steps === 11 ? String(labels[i]).padEnd(4) : String(i + 1).padEnd(4);
    out.push(`${label} ${rgb255ToHex(rgb)}  ${fmtLch(lch)}${mapped ? '  (gamut-mapped)' : ''}`);
  }
  return out.join('\n');
}

function cmdRetint(args) {
  if (args.length < 2) throw new Error('retint needs <colour> <targetColour>');
  const from = parseColour(args[0]);
  const target = parseColour(args[1]);
  const lch = [from.lch[0], from.lch[1], target.lch[2]];
  const { rgb, mapped } = oklchToRgb255(lch);
  return `${rgb255ToHex(rgb)}  ${fmtLch(rgb255ToOklch(rgb))}${mapped ? '  (gamut-mapped)' : ''}  (L and C of ${args[0]}, hue of ${args[1]})`;
}

// ---------- inventory ----------

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.next', '.venv', '__pycache__', '.ruff_cache', 'coverage', '.turbo']);
const TEXT_EXT = new Set(['.css', '.scss', '.less', '.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.xaml', '.axaml', '.cshtml', '.razor']);
const COMPONENT_EXT = new Set(['.jsx', '.tsx', '.vue', '.svelte', '.astro', '.xaml', '.axaml', '.razor']);

function walk(p, files = []) {
  let st;
  try { st = fs.statSync(p); } catch { return files; }
  if (st.isFile()) {
    if (TEXT_EXT.has(path.extname(p).toLowerCase()) && st.size < 1_000_000) files.push(p);
    return files;
  }
  for (const name of fs.readdirSync(p)) {
    if (SKIP_DIRS.has(name)) continue;
    walk(path.join(p, name), files);
  }
  return files;
}

// A value that is only a token reference (or none/0) is not a literal.
const isRef = (v) => /^\s*(?:var\([^)]*\)|none|0|inherit|initial)\s*(?:!important)?\s*$/i.test(v);

const bump = (map, key, loc) => {
  const e = map.get(key) || { n: 0, at: [] };
  e.n++;
  if (e.at.length < 3) e.at.push(loc);
  map.set(key, e);
};

function inventory(paths, { top = 15, delta = 0.03, json = false } = {}) {
  const files = paths.flatMap((p) => walk(p));
  const colours = new Map(); // hex -> {n, at, stray}
  const strayColours = new Map();
  const cats = { 'font-size': new Map(), radius: new Map(), shadow: new Map(), duration: new Map(), 'z-index': new Map(), 'arbitrary-tailwind': new Map() };
  const tokenDefs = []; // {name, value, loc}
  const allText = [];
  const sigs = []; // component structure signatures

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    allText.push(text);
    const ext = path.extname(file).toLowerCase();
    const isXaml = ext === '.xaml' || ext === '.axaml';
    const xamlDict = isXaml && /<ResourceDictionary[\s>]/.test(text.slice(0, 2000)) && !/<(Window|UserControl|Page)[\s>]/.test(text.slice(0, 2000));
    const rel = path.relative(process.cwd(), file) || file;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const loc = `${rel}:${i + 1}`;
      const isDef = /^\s*--[\w-]+\s*:/.test(line) || (xamlDict && /(x:Key|Color=|SolidColorBrush)/.test(line));
      const def = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);?/);
      if (def) tokenDefs.push({ name: def[1], value: def[2].trim().toLowerCase(), loc });
      // colours
      for (const m of line.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)) {
        let h = m[1].toLowerCase();
        if (h.length <= 4) h = [...h].map((c) => c + c).join('');
        const hex = '#' + (h.length === 8 ? (isXaml ? h.slice(2) : h.slice(0, 6)) : h);
        bump(colours, hex, loc);
        if (!isDef) bump(strayColours, hex, loc);
      }
      for (const m of line.matchAll(/\b(?:rgba?|hsla?|oklch)\([^)]*\)/gi)) {
        try {
          if (/^oklch|^rgb/i.test(m[0])) {
            const c = parseColour(m[0]);
            const hex = rgb255ToHex(oklchToRgb255(c.lch).rgb);
            bump(colours, hex, loc);
            if (!isDef) bump(strayColours, hex, loc);
          } else if (!isDef) bump(strayColours, m[0].toLowerCase().replace(/\s+/g, ' '), loc);
        } catch { /* ignore unparseable */ }
      }
      // other literals (outside token definitions)
      if (!isDef) {
        for (const m of line.matchAll(/font-size\s*:\s*([\d.]+(?:px|rem|em|pt|%))/gi)) bump(cats['font-size'], m[1], loc);
        for (const m of line.matchAll(/FontSize\s*=\s*"([\d.]+)"/g)) bump(cats['font-size'], m[1], loc);
        for (const m of line.matchAll(/border-radius\s*:\s*([^;}"']+)/gi)) if (!isRef(m[1])) bump(cats.radius, m[1].trim(), loc);
        for (const m of line.matchAll(/CornerRadius\s*=\s*"([^"]+)"/g)) bump(cats.radius, m[1], loc);
        for (const m of line.matchAll(/box-shadow\s*:\s*([^;}"']+)/gi)) if (!isRef(m[1])) bump(cats.shadow, m[1].trim().replace(/\s+/g, ' '), loc);
        for (const m of line.matchAll(/(?:transition(?:-duration)?|animation(?:-duration)?)\s*:[^;]*?\b([\d.]+m?s)\b/gi)) bump(cats.duration, m[1], loc);
        for (const m of line.matchAll(/Duration\s*=\s*"([^"]+)"/g)) bump(cats.duration, m[1], loc);
        for (const m of line.matchAll(/z-index\s*:\s*(-?\d+)/gi)) bump(cats['z-index'], m[1], loc);
        for (const m of line.matchAll(/\b[a-z-]+-\[[^\]\s]+\]/g)) bump(cats['arbitrary-tailwind'], m[0], loc);
      }
    });
    if (COMPONENT_EXT.has(ext)) {
      const tokens = new Set([...text.matchAll(/<([A-Za-z][\w.:-]*)/g)].map((m) => m[1]));
      for (const m of text.matchAll(/class(?:Name)?\s*=\s*["'{`]([^"'}`]+)/g)) m[1].split(/\s+/).forEach((c) => c && tokens.add('.' + c));
      if (tokens.size >= 8) sigs.push({ file: rel, tokens });
    }
  }

  // colour clusters: distinct values within delta of each other
  const list = [...colours.entries()].map(([hex, v]) => ({ hex, ...v, lch: parseColour(hex).lch }));
  const clusters = [];
  const used = new Set();
  list.sort((a, b) => b.n - a.n);
  for (const c of list) {
    if (used.has(c.hex)) continue;
    const members = list.filter((o) => !used.has(o.hex) && deltaE(c.lch, o.lch) <= delta);
    members.forEach((m) => used.add(m.hex));
    if (members.length > 1) clusters.push(members);
  }

  // duplicate and unused tokens
  const byValue = new Map();
  for (const t of tokenDefs) {
    const k = t.value;
    (byValue.get(k) || byValue.set(k, []).get(k)).push(t);
  }
  const dupes = [...byValue.values()].filter((g) => new Set(g.map((t) => t.name)).size > 1 && g[0].value.length > 2 && !/^var\(/.test(g[0].value));
  // A token is "unused" when no line outside its own definition mentions it, either as --name or as a
  // Tailwind-style utility built from the bare name (bg-primary, text-foreground).
  const allLines = allText.flatMap((t) => t.split(/\r?\n/));
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const unused = [...new Set(tokenDefs.map((t) => t.name))].filter((name) => {
    const bare = name.replace(/^--/, '').replace(/^(color|radius|font|text|spacing|shadow|ease|animate)-/, '');
    const nameRe = new RegExp('(?<![\\w-])' + esc(name) + '(?![\\w-])');
    const bareRe = bare ? new RegExp('(?<!\\w)' + esc(bare) + '(?![\\w-])') : null;
    const ownDef = new RegExp('^\\s*' + esc(name) + '\\s*:');
    return !allLines.some((l) => !ownDef.test(l) && (nameRe.test(l) || (bareRe && bareRe.test(l))));
  });

  // similar components
  const similar = [];
  const cap = sigs.slice(0, 400);
  for (let i = 0; i < cap.length; i++) {
    for (let j = i + 1; j < cap.length; j++) {
      const a = cap[i].tokens;
      const b = cap[j].tokens;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const jac = inter / (a.size + b.size - inter);
      if (jac >= 0.8) similar.push({ a: cap[i].file, b: cap[j].file, jac });
    }
  }
  similar.sort((x, y) => y.jac - x.jac);

  const topOf = (map) => [...map.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, top).map(([value, v]) => ({ value, n: v.n, at: v.at }));
  const result = {
    filesScanned: files.length,
    colours: { distinct: colours.size, strayDistinct: strayColours.size, strayTotal: [...strayColours.values()].reduce((s, v) => s + v.n, 0), topStray: topOf(strayColours) },
    nearDuplicateColourClusters: clusters.slice(0, top).map((g) => g.map((m) => ({ hex: m.hex, n: m.n, at: m.at[0] }))),
    ...Object.fromEntries(Object.entries(cats).map(([k, map]) => [k, { distinct: map.size, total: [...map.values()].reduce((s, v) => s + v.n, 0), top: topOf(map) }])),
    duplicateTokens: dupes.slice(0, top).map((g) => ({ value: g[0].value, names: g.map((t) => t.name), at: g[0].loc })),
    unusedTokenCandidates: unused.slice(0, top * 2),
    similarComponentCandidates: similar.slice(0, top).map((s) => ({ ...s, jac: Number(s.jac.toFixed(2)) })),
  };
  if (json) return JSON.stringify(result, null, 2);

  const L = [];
  L.push(`scanned ${result.filesScanned} files`);
  L.push(`colours: ${result.colours.distinct} distinct, ${result.colours.strayDistinct} distinct outside token definitions (${result.colours.strayTotal} uses)`);
  for (const s of result.colours.topStray) L.push(`  stray ${s.value}  x${s.n}  ${s.at[0]}`);
  L.push(`near-duplicate colour clusters (within dE ${delta}): ${clusters.length}`);
  for (const g of result.nearDuplicateColourClusters) L.push('  ' + g.map((m) => `${m.hex} x${m.n}`).join(' ~ ') + `  (${g[0].at})`);
  for (const [k, v] of Object.entries(result).filter(([k]) => k in cats)) {
    L.push(`${k} literals outside tokens: ${v.distinct} distinct, ${v.total} uses`);
    for (const t of v.top) L.push(`  ${t.value}  x${t.n}  ${t.at[0]}`);
  }
  L.push('note: duplicate/unused token analysis reads CSS custom properties only; XAML ResourceDictionary keys and XAML Margin/Padding are not analysed (0 here does not mean clean)');
  L.push(`tokens defined twice under different names: ${dupes.length}`);
  for (const d of result.duplicateTokens) L.push(`  ${d.value}  <- ${d.names.join(', ')}  (${d.at})`);
  L.push(`unused token candidates (verify before deleting; Tailwind utilities can hide uses): ${unused.length}`);
  for (const u of result.unusedTokenCandidates) L.push(`  ${u}`);
  L.push(`similar components, structure only (candidates, read both before merging): ${similar.length}`);
  for (const s of result.similarComponentCandidates) L.push(`  ${s.jac}  ${s.a}  ~  ${s.b}`);
  return L.join('\n');
}

// ---------- catalog: row lookup in the local CSV data set, and sections of the big reference documents ----------
// The data set is large (styles.csv alone is 154 KB) and a lookup needs a few rows, so these print only what matches.

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = path.join(SKILL_DIR, 'references', 'ui-catalog');

// RFC 4180: quoted fields may hold commas, doubled quotes and line breaks.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
function listCsvNames(dir) {
  const out = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) { for (const m of fs.readdirSync(p)) if (m.endsWith('.csv')) out.push(`${n}/${m.slice(0, -4)}`); } else if (n.endsWith('.csv')) out.push(n.slice(0, -4));
  }
  return out.sort();
}

// catalog <file> [--q "words"] [--where "Column=regex"]... [--cols "A,B"] [--limit 8] [--full] [--list]
function cmdCatalog(args, dir = CATALOG_DIR) {
  const o = { q: '', where: [], cols: null, limit: 8, full: false, list: false }; let file = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--q') o.q = args[++i] || '';
    else if (a === '--where') o.where.push(args[++i] || '');
    else if (a === '--cols') o.cols = String(args[++i] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--limit') o.limit = Number(args[++i]);
    else if (a === '--full') o.full = true;
    else if (a === '--list') o.list = true;
    else if (!file) file = a;
  }
  if (!file) throw new Error(`catalog needs a file name. Available: ${listCsvNames(dir).join(', ')}`);
  const full = path.resolve(dir, `${file.replace(/\.csv$/i, '')}.csv`);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('catalog reads only inside the ui-catalog folder');
  if (!fs.existsSync(full)) throw new Error(`no catalog file "${file}". Available: ${listCsvNames(dir).join(', ')}`);
  if (!(o.limit >= 1)) throw new Error('--limit must be a positive number');
  const [header, ...data] = parseCsv(fs.readFileSync(full, 'utf8'));
  const col = (name) => {
    const n = name.toLowerCase();
    const i = header.findIndex((h) => h.toLowerCase() === n); const j = i >= 0 ? i : header.findIndex((h) => h.toLowerCase().startsWith(n));
    if (j < 0) throw new Error(`no column "${name}" in ${file}. Columns: ${header.join(' | ')}`);
    return j;
  };
  if (o.list) return [`${file}: ${data.length} row(s); columns: ${header.join(' | ')}`, ...data.map((r) => `  ${r.slice(0, 3).map((x) => clip(x, 50)).join(' | ')}`)].join('\n');
  let rows = data;
  for (const w of o.where) {
    const k = w.indexOf('='); if (k < 1) throw new Error(`--where wants Column=regex, got "${w}"`);
    const idx = col(w.slice(0, k)); const re = new RegExp(w.slice(k + 1), 'i');
    rows = rows.filter((r) => re.test(r[idx] || ''));
  }
  const words = [...new Set(o.q.toLowerCase().split(/[\s,]+/).filter((x) => x.length > 1))];
  let scored = rows.map((r) => {
    const all = r.join(' ').toLowerCase(); const name = (r[1] || '').toLowerCase();
    return { r, s: words.reduce((t, x) => t + (all.includes(x) ? 1 : 0) + (name.includes(x) ? 1 : 0), 0) };
  });
  if (words.length) scored = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const picked = scored.slice(0, o.limit);
  if (!picked.length) return `catalog ${file}: no row matched${words.length ? ` "${o.q}"` : ''}${o.where.length ? ` with ${o.where.join(' and ')}` : ''} (of ${data.length}). Try fewer or other words, \`--list\` for the names, or check the columns: ${header.join(' | ')}`;
  const want = o.cols ? o.cols.map(col) : header.map((_, i) => i);
  const out = [`catalog ${file}: ${scored.length} of ${data.length} row(s) match, showing ${picked.length}${scored.length > picked.length ? ' (--limit for more)' : ''}`];
  for (const { r } of picked) {
    out.push(`#${r[0]}`);
    for (const i of want) if (i !== 0 && (r[i] || '') !== '') out.push(`  ${header[i]}: ${o.full ? r[i] : clip(r[i], 240)}`);
  }
  return out.join('\n');
}

// Headings of a Markdown file (code fences skipped), each with the line range of its section.
function mdOutline(text) {
  const lines = text.split(/\r?\n/); const heads = []; let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { fence = !fence; return; }
    const m = !fence && /^(#{1,6})\s+(.+?)\s*$/.exec(l);
    if (m) heads.push({ level: m[1].length, title: m[2], start: i + 1 });
  });
  heads.forEach((h, k) => { const next = heads.slice(k + 1).find((x) => x.level <= h.level); h.end = next ? next.start - 1 : lines.length; });
  return { lines, heads };
}
function skillFile(file) {
  const full = path.resolve(SKILL_DIR, file);
  if (!full.startsWith(SKILL_DIR + path.sep) || !fs.existsSync(full)) throw new Error(`"${file}" is not a file inside the design skill folder (give a path relative to it, e.g. references/styles/liquid-glass/SPEC.md)`);
  return full;
}
function cmdToc(args, base) {
  if (!args[0]) throw new Error('toc needs a file');
  const { heads } = mdOutline(fs.readFileSync(base || skillFile(args[0]), 'utf8'));
  return [`${args[0]}: ${heads.length} heading(s); \`section ${args[0]} "<heading words>"\` prints one`, ...heads.filter((h) => h.level <= 3).map((h) => `  L${h.start}-${h.end}  ${'#'.repeat(h.level)} ${h.title}`)].join('\n');
}
function cmdSection(args, base) {
  const full = args.includes('--full'); const rest = args.filter((a) => a !== '--full');
  if (rest.length < 2) throw new Error('section needs a file and a heading pattern (a regex, case-insensitive)');
  const { lines, heads } = mdOutline(fs.readFileSync(base || skillFile(rest[0]), 'utf8'));
  const re = new RegExp(rest[1], 'i');
  const hits = heads.filter((h) => re.test(h.title));
  if (!hits.length) throw new Error(`no heading matches /${rest[1]}/ in ${rest[0]}; \`toc ${rest[0]}\` lists them`);
  const h = hits[0]; const body = lines.slice(h.start - 1, h.end);
  const cap = full ? Infinity : 400;
  return [`${rest[0]} L${h.start}-${h.end}${hits.length > 1 ? ` (first of ${hits.length} matches: ${hits.slice(1, 6).map((x) => `"${x.title}"`).join(', ')})` : ''}`, ...body.slice(0, cap), ...(body.length > cap ? [`… ${body.length - cap} more line(s): rerun with --full`] : [])].join('\n');
}

// ---------- self-test ----------

function selfTest() {
  const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} +/- ${tol}`);
  // conversions against independently published values
  const white = parseColour('#ffffff').lch;
  near(white[0], 1, 0.001, 'white L');
  near(white[1], 0, 0.001, 'white C');
  const black = parseColour('#000000').lch;
  near(black[0], 0, 0.001, 'black L');
  const red = parseColour('#ff0000').lch;
  near(red[0], 0.628, 0.002, 'red L');
  near(red[1], 0.2577, 0.002, 'red C');
  near(red[2], 29.23, 0.3, 'red H');
  // round trip
  for (const hex of ['#3b82f6', '#767676', '#0f172a', '#14b8a6', '#fafaf9']) {
    const back = rgb255ToHex(oklchToRgb255(parseColour(hex).lch).rgb);
    assert.equal(back, hex, `round trip ${hex}`);
  }
  // contrast against known values
  near(contrastRatio([0, 0, 0], [255, 255, 255]), 21, 0.01, 'black/white');
  near(contrastRatio(parseColour('#767676').rgb, [255, 255, 255]), 4.54, 0.02, '#767676 on white');
  near(contrastRatio(parseColour('#777777').rgb, [255, 255, 255]), 4.48, 0.02, '#777777 on white');
  near(contrastRatio([255, 255, 255], [255, 255, 255]), 1, 0.001, 'same colour');
  // parsing forms
  assert.deepEqual(parseColour('#fff').rgb, [255, 255, 255]);
  assert.deepEqual(parseColour('rgb(255, 0, 0)').rgb, [255, 0, 0]);
  assert.deepEqual(parseColour('color(srgb 1 0 0)').rgb, [255, 0, 0]);
  assert.deepEqual(parseColour('rgba(0, 0, 0, 0.5)').rgb, [0, 0, 0]);
  assert.equal(rgb255ToHex(parseColour('oklch(100% 0 0)').rgb), '#ffffff');
  // gamut mapping never leaves sRGB and reports it
  const wild = oklchToRgb255([0.7, 0.4, 150]);
  assert.ok(wild.mapped && wild.rgb.every((v) => v >= 0 && v <= 255), 'gamut mapping');
  // retint keeps lightness, changes hue
  const tinted = parseColour(cmdRetint(['#3b82f6', '#14b8a6']).split(/\s+/)[0]);
  near(tinted.lch[0], parseColour('#3b82f6').lch[0], 0.03, 'retint keeps L');
  // ramp is monotonic in lightness
  const rampLs = cmdRamp(['#3b82f6']).split('\n').slice(1).map((l) => Number(l.match(/oklch\(([\d.]+)/)[1]));
  for (let i = 1; i < rampLs.length; i++) assert.ok(rampLs[i] < rampLs[i - 1] + 0.001, 'ramp descends');
  // inventory on a temp fixture
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '.', 'design-tools-'));
  try {
    fs.writeFileSync(path.join(dir, 'tokens.css'), ':root {\n  --accent: #3b82f6;\n  --brand: #3b82f6;\n  --unused-thing: #123456;\n  --color-primary: #111111;\n  --card: var(--accent);\n  --ring: var(--accent);\n}\n');
    fs.writeFileSync(path.join(dir, 'a.css'), '.a { color: #3a80f4; background: var(--accent); font-size: 13px; border-radius: 6px; }\n.b { font-size: 14px; border-radius: var(--r); box-shadow: none; }\n');
    fs.writeFileSync(path.join(dir, 'b.tsx'), 'export const B = () => <div className="bg-primary">x</div>;\n');
    const out = inventory([dir], { top: 5 });
    assert.match(out, /radius literals outside tokens: 1 distinct/, 'var() radius is not a literal');
    assert.doesNotMatch(out, /--color-primary\s*$/m, 'Tailwind utility use counts as used');
    assert.doesNotMatch(out, /var\(--accent\)\s+<-/, 'alias tokens are not reported as duplicates');
    assert.match(out, /near-duplicate colour clusters[^\n]*: 1/, 'finds the #3b82f6 ~ #3a80f4 cluster');
    assert.match(out, /tokens defined twice under different names: 1/, 'finds duplicate token');
    assert.match(out, /unused-thing/, 'finds unused token');
    assert.match(out, /font-size literals outside tokens: 2 distinct/, 'counts font sizes');
    // catalog: quoted commas and line breaks survive, filters and scoring work, nothing outside the folder is read
    assert.deepEqual(parseCsv('No,Name,Note\n1,"a, b","line\nbreak ""q"""\n2,c,d\n'), [['No', 'Name', 'Note'], ['1', 'a, b', 'line\nbreak "q"'], ['2', 'c', 'd']]);
    fs.writeFileSync(path.join(dir, 'demo.csv'), 'No,Name,Keywords,Status\n1,Glass panel,"blur, frosted",active\n2,Flat card,"plain, solid",active\n3,Old glass,"blur",deprecated\n');
    const hit = cmdCatalog(['demo', '--q', 'frosted blur'], dir);
    assert.match(hit, /1 of 3 row\(s\) match|2 of 3 row\(s\) match/); assert.match(hit, /^#1$/m); assert.ok(hit.indexOf('#1') < hit.indexOf('#3'), 'the row matching more words ranks first');
    assert.doesNotMatch(cmdCatalog(['demo', '--q', 'blur', '--where', 'Status=active'], dir), /#3/, '--where filters');
    assert.match(cmdCatalog(['demo', '--q', 'blur', '--cols', 'Name'], dir), /Name: Glass panel/); assert.doesNotMatch(cmdCatalog(['demo', '--q', 'blur', '--cols', 'Name'], dir), /Keywords:/);
    assert.match(cmdCatalog(['demo', '--q', 'zzzz'], dir), /no row matched/); assert.match(cmdCatalog(['demo', '--list'], dir), /3 row\(s\)/);
    assert.throws(() => cmdCatalog(['demo', '--where', 'Nope=x'], dir), /no column "Nope"/); assert.throws(() => cmdCatalog(['../demo'], dir), /only inside|no catalog file/);
    assert.match(cmdCatalog(['styles', '--q', 'glass', '--where', 'Status=active', '--limit', '2']), /row\(s\) match/, 'the real styles.csv is readable');
    // toc / section: headings inside code fences are ignored, a section ends at the next heading of its level or higher
    fs.writeFileSync(path.join(dir, 'doc.md'), '# Top\n\nintro\n\n## One\n\none body\n```\n# not a heading\n```\n\n### One-a\n\nsub\n\n## Two\n\ntwo body\n');
    assert.match(cmdToc(['doc.md'], path.join(dir, 'doc.md')), /L5-15 {2}## One[\s\S]*L12-15 {2}### One-a[\s\S]*L16-19 {2}## Two/);
    assert.doesNotMatch(cmdToc(['doc.md'], path.join(dir, 'doc.md')), /not a heading/, 'a # line inside a code fence is not a heading');
    const sec = cmdSection(['doc.md', '^one$'], path.join(dir, 'doc.md'));
    assert.match(sec, /one body/); assert.match(sec, /sub/); assert.doesNotMatch(sec, /two body/); assert.match(sec, /# not a heading/);
    assert.throws(() => cmdSection(['doc.md', 'zzz'], path.join(dir, 'doc.md')), /no heading matches/); assert.throws(() => skillFile('../../../CLAUDE.md'), /not a file inside the design skill folder/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return 'self-test: all checks passed';
}

// ---------- main ----------

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'contrast': return cmdContrast(rest);
    case 'oklch': return cmdOklch(rest);
    case 'hex': return cmdHex(rest);
    case 'ramp': return cmdRamp(rest);
    case 'retint': return cmdRetint(rest);
    case '--self-test': return selfTest();
    case 'catalog': return cmdCatalog(rest);
    case 'toc': return cmdToc(rest);
    case 'section': return cmdSection(rest);
    case 'inventory': {
      const opt = { top: 15, delta: 0.03, json: false };
      const paths = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--top') opt.top = Number(rest[++i]);
        else if (rest[i] === '--delta') opt.delta = Number(rest[++i]);
        else if (rest[i] === '--json') opt.json = true;
        else paths.push(rest[i]);
      }
      if (!paths.length) throw new Error('inventory needs at least one path');
      return inventory(paths, opt);
    }
    default:
      return 'usage: contrast <fg> <bg> ... | oklch <colour> | hex <colour> | ramp <colour> [--steps N] | retint <colour> <target> | inventory <path...> [--top N] [--delta D] [--json] | catalog <file> [--q words] [--where Col=regex] [--cols A,B] [--limit N] [--full] [--list] | toc <md file> | section <md file> <heading regex> [--full] | --self-test';
  }
}

try {
  console.log(main(process.argv.slice(2)));
} catch (e) {
  console.error(`design-tools: ${e.message}`);
  process.exit(1);
}
