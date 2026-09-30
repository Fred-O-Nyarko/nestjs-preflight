#!/usr/bin/env node
/**
 * nestjs-preflight — static scanner
 *
 * Collects heuristic signals for the 17 checks in the NestJS team's
 * "NestJS Production Checklist: 17 Checks Before You Deploy" and prints a
 * report (markdown or JSON). It never modifies the project it scans.
 *
 * Zero dependencies. Node >= 18.
 *
 *   node scan.mjs [path] [--format md|json] [--out FILE]
 *                 [--fail-on fail|warn|none] [--only 1,4,13] [--today YYYY-MM-DD]
 *
 * The scanner is deliberately conservative: it reports what it can see in
 * source, Dockerfiles, Kubernetes manifests, CI config and package.json.
 * Anything it cannot decide statically is reported as `manual` so a human
 * (or the agent running the skill) can verify it.
 *
 * MIT License — see LICENSE at the repository root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 50_000;
const MAX_EVIDENCE = 8;

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.turbo',
  '.cache', 'out', 'tmp', '.idea', '.vscode', '.yarn', '.pnpm-store', 'vendor', '.angular',
]);
const CODE_EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx']);
const TEXT_EXT = new Set([
  ...CODE_EXT, '.json', '.json5', '.yaml', '.yml', '.toml', '.sh', '.bash', '.env',
  '.prisma', '.md', '.txt', '.conf', '.ini', '.dockerfile', '',
]);

// Node.js release lines (https://nodejs.org/en/about/previous-releases).
// Keep this table current — it is the only date-sensitive data in the scanner.
const NODE_LINES = {
  16: { lts: '2021-10-26', eol: '2023-09-11' },
  18: { lts: '2022-10-25', eol: '2025-04-30' },
  20: { lts: '2023-10-24', eol: '2026-04-30' },
  22: { lts: '2024-10-29', eol: '2027-04-30' },
  24: { lts: '2025-10-28', eol: '2028-04-30' },
  26: { lts: '2026-10-28', eol: '2029-04-30' },
};

// First @nestjs/core release that ships each API (verified against the published typings).
const FEATURE_MIN = {
  useSecurityHeaders: '12.1.0',
  return503OnClosing: '12.0.0',
  StandardSchemaValidationPipe: '12.0.0',
};
function semverGte(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) || [];
  const pb = String(b).match(/\d+/g)?.map(Number) || [];
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

const LEVEL_RANK = { fail: 5, warn: 4, manual: 3, pass: 2, info: 1 };
const STATUS_ORDER = ['fail', 'warn', 'manual', 'pass', 'n/a'];

const CHECKS = [
  [1, 'Startup and deploys', 'Validate config at boot; keep secrets out of the image'],
  [2, 'Startup and deploys', 'Handle SIGTERM and get the container right'],
  [3, 'Startup and deploys', 'Drain traffic before you close'],
  [4, 'Startup and deploys', 'Scheduled jobs run on every replica'],
  [5, 'The edge', 'Authentication is deny-by-default'],
  [6, 'The edge', 'Security headers, CORS, rate limits, trust proxy'],
  [7, 'Input and output', 'Validate every input'],
  [8, 'Input and output', 'Control what goes out'],
  [9, 'Input and output', 'Make writes safe to repeat'],
  [10, 'Dependencies', 'Run current Node, Nest and dependencies'],
  [11, 'Dependencies', 'Time out every outbound call'],
  [12, 'Dependencies', 'Plan for dependencies that are down'],
  [13, 'Dependencies', 'Run migrations as a deploy step'],
  [14, 'Dependencies', 'Check the connection pool math'],
  [15, 'Dependencies', 'Watch for request-scoped chains'],
  [16, 'Errors and visibility', 'Errors: statuses, logs, source maps'],
  [17, 'Errors and visibility', 'Logs, health checks, monitoring'],
];
const REF_FILE = {
  1: 'references/01-startup-and-deploys.md', 2: 'references/01-startup-and-deploys.md',
  3: 'references/01-startup-and-deploys.md', 4: 'references/01-startup-and-deploys.md',
  5: 'references/02-the-edge.md', 6: 'references/02-the-edge.md',
  7: 'references/03-input-and-output.md', 8: 'references/03-input-and-output.md',
  9: 'references/03-input-and-output.md',
  10: 'references/04-dependencies.md', 11: 'references/04-dependencies.md',
  12: 'references/04-dependencies.md', 13: 'references/04-dependencies.md',
  14: 'references/04-dependencies.md', 15: 'references/04-dependencies.md',
  16: 'references/05-errors-and-visibility.md', 17: 'references/05-errors-and-visibility.md',
};

// ───────────────────────────── CLI ─────────────────────────────

function parseArgs(argv) {
  const opts = { root: '.', format: 'md', out: null, failOn: 'none', only: null, today: null };
  const args = [];
  for (const a of argv) {
    if (a.startsWith('--') && a.includes('=')) args.push(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
    else args.push(a);
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) die(`Missing value for ${a}`);
      return v;
    };
    if (a === '--format' || a === '-f') opts.format = next();
    else if (a === '--out' || a === '-o') opts.out = next();
    else if (a === '--fail-on') opts.failOn = next();
    else if (a === '--ci') opts.failOn = 'fail';
    else if (a === '--only') opts.only = new Set(next().split(',').map((s) => Number(s.trim())).filter(Boolean));
    else if (a === '--today') opts.today = next();
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
    else if (a.startsWith('-')) die(`Unknown option ${a}`);
    else opts.root = a;
  }
  if (!['md', 'json'].includes(opts.format)) die('--format must be md or json');
  if (!['fail', 'warn', 'none'].includes(opts.failOn)) die('--fail-on must be fail, warn or none');
  return opts;
}

function printHelp() {
  console.log(`nestjs-preflight scanner v${VERSION}

Usage: node scan.mjs [path] [options]

Options:
  -f, --format md|json   Output format (default: md)
  -o, --out FILE         Write the report to FILE instead of stdout
      --fail-on LEVEL    Exit 1 if any check is at LEVEL or worse: fail | warn | none (default: none)
      --ci               Shorthand for --fail-on fail
      --only 1,4,13      Run only these check numbers
      --today YYYY-MM-DD Evaluate Node.js EOL dates against this date (default: now)
  -h, --help             Show help
  -v, --version          Show version`);
}

function die(msg) {
  console.error(`scan: ${msg}`);
  process.exit(2);
}

// ─────────────────────────── helpers ───────────────────────────

const toPosix = (p) => p.split(path.sep).join('/');

/** Remove // and /* *\/ comments while preserving string contents and line numbers. */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 0; // 0 code, 1 ', 2 ", 3 `, 4 line comment, 5 block comment
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 0) {
      if (c === '/' && d === '/' && src[i - 1] !== '\\' && src[i - 1] !== ':') { state = 4; i += 2; continue; }
      if (c === '/' && d === '*') { state = 5; i += 2; continue; }
      if (c === "'") state = 1;
      else if (c === '"') state = 2;
      else if (c === '`') state = 3;
      out += c; i++; continue;
    }
    if (state === 4) { if (c === '\n') { state = 0; out += c; } i++; continue; }
    if (state === 5) {
      if (c === '*' && d === '/') { state = 0; i += 2; continue; }
      if (c === '\n') out += c;
      i++; continue;
    }
    out += c;
    if (c === '\\' && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
    if ((state === 1 && c === "'") || (state === 2 && c === '"') || (state === 3 && c === '`')) state = 0;
    else if ((state === 1 || state === 2) && c === '\n') state = 0;
    i++;
  }
  return out;
}

/** Remove full-line `#` comments (Dockerfile, YAML, TOML, shell, .env). */
function stripHashComments(src) {
  return src.replace(/^[ \t]*#.*$/gm, '');
}

function makeFile(root, abs) {
  const rel = toPosix(path.relative(root, abs));
  const base = path.basename(abs);
  const ext = path.extname(abs).toLowerCase();
  let raw; let text; let lines; let starts;
  const f = {
    abs, rel, base, ext,
    get raw() {
      if (raw === undefined) {
        try {
          const st = fs.statSync(abs);
          raw = st.size > MAX_FILE_BYTES ? '' : fs.readFileSync(abs, 'utf8');
        } catch { raw = ''; }
      }
      return raw;
    },
    get text() {
      if (text === undefined) {
        if (CODE_EXT.has(ext)) text = stripComments(f.raw);
        else if (isHashCommented(f)) text = stripHashComments(f.raw);
        else text = f.raw;
      }
      return text;
    },
    get lines() {
      if (lines === undefined) lines = f.text.split('\n');
      return lines;
    },
    lineAt(index) {
      if (!starts) {
        starts = [0];
        const t = f.text;
        for (let k = 0; k < t.length; k++) if (t[k] === '\n') starts.push(k + 1);
      }
      let lo = 0; let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= index) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    },
    window(line, before, after) {
      const L = f.lines;
      return L.slice(Math.max(0, line - 1 - before), Math.min(L.length, line + after)).join('\n');
    },
  };
  return f;
}

function isHashCommented(f) {
  return /^(dockerfile|containerfile)/i.test(f.base) || /\.dockerfile$/i.test(f.base) ||
    ['.yaml', '.yml', '.toml', '.sh', '.bash', '.env'].includes(f.ext) ||
    /^\.env/.test(f.base) || /^procfile$/i.test(f.base) || f.base === '.dockerignore' ||
    f.base === '.gitignore' || f.base === '.tool-versions';
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) stack.push(abs); }
      else if (e.isFile()) out.push(abs);
    }
  }
  return out.sort();
}

/** Find every regex match across files. Returns hits with file + line. */
function find(files, re, max = 500) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const g = new RegExp(re.source, flags);
  const hits = [];
  for (const f of files) {
    const t = f.text;
    if (!t) continue;
    g.lastIndex = 0;
    let m;
    while ((m = g.exec(t))) {
      hits.push({ file: f, index: m.index, m, line: f.lineAt(m.index) });
      if (m[0].length === 0) g.lastIndex++;
      if (hits.length >= max) return hits;
    }
  }
  return hits;
}

/** From the "(" at openIdx, return the text up to the matching ")" (exclusive). */
function balanced(text, openIdx, limit = 4000) {
  let depth = 0;
  for (let i = openIdx; i < text.length && i < openIdx + limit; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return text.slice(openIdx + 1, openIdx + limit);
}
const argsOf = (hit) => {
  const open = hit.file.text.indexOf('(', hit.index + hit.m[0].length - 1);
  return open === -1 ? '' : balanced(hit.file.text, open);
};

/** Never echo secret values into a report. */
const SECRET_NAME = '\\w*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)\\w*';
function redact(line, isCode = false) {
  let out = line.replace(/(\/\/[^:/\s'"`@]+:)[^@\s'"`]+@/g, '$1***@');
  out = isCode
    // code: only literal strings assigned to secret-looking names
    ? out.replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)(['"\`])([^'"\`]{3,})\\3`, 'gi'), '$1$2$3***$3')
    // Dockerfile / YAML / .env: KEY=value, KEY: value, ENV KEY value
    : out.replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*|\\s+)(['"]?)(?![*$<{])[^\\s'"]{3,}\\3`, 'gi'), '$1$2$3***$3');
  return out;
}

function ev(hits, note) {
  return hits.map((h) => ({
    file: h.file.rel,
    line: h.line,
    snippet: redact((h.file.lines[h.line - 1] || '').trim(), CODE_EXT.has(h.file.ext)).slice(0, 180),
    ...(note ? { note: typeof note === 'function' ? note(h) : note } : {}),
  }));
}
const evFile = (f, note) => ({ file: f.rel, line: 1, snippet: '', ...(note ? { note } : {}) });
const uniqFiles = (hits) => [...new Set(hits.map((h) => h.file))];
const dedupeLines = (hits) => {
  const seen = new Set();
  return hits.filter((h) => {
    const k = `${h.file.rel}:${h.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

function majorOf(v) {
  if (!v) return null;
  const m = String(v).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// ─────────────────────────── context ───────────────────────────

function buildContext(root, today) {
  const all = walk(root).map((abs) => makeFile(root, abs));
  const textFiles = all.filter((f) => TEXT_EXT.has(f.ext) || /^(dockerfile|containerfile|procfile)/i.test(f.base) || /^\.(env|nvmrc|node-version|dockerignore|gitignore|tool-versions)/.test(f.base));
  const isTest = (f) => /(^|\/)(test|tests|__tests__|e2e|__mocks__)\//.test(f.rel) || /\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/.test(f.base);
  const code = textFiles.filter((f) => CODE_EXT.has(f.ext) && !f.base.endsWith('.d.ts'));
  const toolingConfig = /(^|\/)(\.?eslint(rc)?|eslint\.config|prettier(rc)?|\.?prettierrc|jest\.config|vitest\.config|webpack\.config|rollup\.config|vite\.config|tsup\.config|commitlint\.config|lint-staged\.config|babel\.config|\.?lintstagedrc|nodemon)\b[\w.-]*\.[cm]?[jt]s$/;
  const src = code.filter((f) => !isTest(f) && !/(^|\/)(scripts?|tools?)\//.test(f.rel) && !toolingConfig.test(f.rel));
  const dockerfiles = textFiles.filter((f) => /^(dockerfile|containerfile)/i.test(f.base) || /\.dockerfile$/i.test(f.base));
  const yaml = textFiles.filter((f) => ['.yaml', '.yml'].includes(f.ext));
  const k8s = yaml.filter((f) => /^\s*kind:\s*(Deployment|StatefulSet|DaemonSet|Job|CronJob|HorizontalPodAutoscaler|Rollout|Service|Pod)\b/m.test(f.text) || /(^|\/)(charts?|helm|k8s|kubernetes|deploy|manifests?)\//.test(f.rel));
  const compose = yaml.filter((f) => /(docker-)?compose[\w.-]*\.ya?ml$/.test(f.base));
  const ci = textFiles.filter((f) => /^\.github\/workflows\//.test(f.rel) || /(^|\/)\.gitlab-ci\.ya?ml$/.test(f.rel) || /^\.circleci\//.test(f.rel) || /(azure-pipelines|bitbucket-pipelines|cloudbuild|buildspec)\.ya?ml$/.test(f.base) || f.base === 'Jenkinsfile');
  const platform = textFiles.filter((f) => /^(procfile|fly\.toml|render\.ya?ml|app\.ya?ml|railway\.json|railway\.toml|app\.json|nixpacks\.toml|vercel\.json|heroku\.yml|apprunner\.ya?ml|serverless\.ya?ml)$/i.test(f.base));
  const shell = textFiles.filter((f) => ['.sh', '.bash'].includes(f.ext));
  const pkgFiles = textFiles.filter((f) => f.base === 'package.json');
  const pkgs = pkgFiles.map((f) => ({ file: f, json: readJson(f.abs) || {} }));

  const deps = new Map();
  const prodDeps = new Set();
  for (const { json } of pkgs) {
    for (const name of Object.keys(json.dependencies || {})) prodDeps.add(name);
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(json[key] || {})) if (!deps.has(name)) deps.set(name, spec);
    }
  }
  const rootPkg = readJson(path.join(root, 'package.json')) || pkgs[0]?.json || {};
  const lock = readJson(path.join(root, 'package-lock.json'));
  let yarnLock = null;
  try { yarnLock = fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8'); } catch { /* none */ }
  let pnpmLock = null;
  try { pnpmLock = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'); } catch { /* none */ }

  function installed(name) { return resolve(name)?.version || null; }
  function resolve(name) {
    const r = resolveRaw(name);
    if (r === null) return null;
    return typeof r === 'string' ? { version: r, source: 'lockfile' } : r;
  }
  function resolveRaw(name) {
    const nm = readJson(path.join(root, 'node_modules', name, 'package.json'));
    if (nm?.version) return { version: nm.version, source: 'installed' };
    const lp = lock?.packages?.[`node_modules/${name}`]?.version || lock?.dependencies?.[name]?.version;
    if (lp) return lp;
    if (yarnLock) {
      const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const m = yarnLock.match(new RegExp(`^"?${esc}@[^\\n]*:\\n\\s+version:?\\s+"?([\\d.]+[^"\\s]*)`, 'm'));
      if (m) return m[1];
    }
    if (pnpmLock) {
      const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const m = pnpmLock.match(new RegExp(`['"]?/?${esc}@(\\d+\\.\\d+\\.\\d+[^('":\\s]*)`, 'm'));
      if (m) return m[1];
    }
    const spec = deps.get(name);
    return spec ? { version: spec.replace(/^[^\d]*/, '') || spec, source: 'declared', spec } : null;
  }

  const featureCache = new Map();
  /** true / false if the identifier appears in the installed packages' typings; null if not installed. */
  function feature(identifier, pkgNames) {
    const key = `${identifier}|${pkgNames.join(',')}`;
    if (featureCache.has(key)) return featureCache.get(key);
    let anyInstalled = false;
    let found = false;
    for (const pkg of pkgNames) {
      const dir = path.join(root, 'node_modules', pkg);
      if (!fs.existsSync(dir)) continue;
      anyInstalled = true;
      const stack = [dir];
      let count = 0;
      while (stack.length && !found && count < 4000) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isDirectory() && e.name !== 'node_modules') stack.push(p);
          else if (e.isFile() && e.name.endsWith('.d.ts')) {
            count++;
            try { if (fs.readFileSync(p, 'utf8').includes(identifier)) { found = true; break; } } catch { /* skip */ }
          }
        }
      }
      if (found) break;
    }
    let res = anyInstalled ? found : null;
    if (res === null && FEATURE_MIN[identifier]) {
      // Not installed: compare the locked/declared version with the release that introduced it.
      const v = resolve('@nestjs/core');
      if (v) res = semverGte(v.version, FEATURE_MIN[identifier]);
    }
    featureCache.set(key, res);
    return res;
  }

  // Lockfiles etc. often live at a monorepo root above the scanned app.
  const ancestorFiles = [];
  {
    let dir = path.dirname(root);
    for (let i = 0; i < 4 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
      if (!fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, '.git'))) break;
      for (const n of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json', 'renovate.json', '.nvmrc', '.node-version', '.tool-versions', 'mise.toml', '.mise.toml']) {
        if (fs.existsSync(path.join(dir, n))) ancestorFiles.push({ base: n, rel: toPosix(path.relative(root, path.join(dir, n))), abs: path.join(dir, n) });
      }
      if (fs.existsSync(path.join(dir, '.git'))) break;
    }
  }

  let gitTracked = null;
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    gitTracked = new Set(out.toString('utf8').split('\0').filter(Boolean));
  } catch { /* not a git repo */ }

  // Scripts that run in production (start*, deploy*, release*, postinstall…)
  const prodScripts = [];
  for (const { file, json } of pkgs) {
    for (const [name, cmd] of Object.entries(json.scripts || {})) {
      if (/^(pre|post)?(start|deploy|release|prod|serve|launch)(:|$)|^postinstall$|:prod$/.test(name)) {
        const idx = file.raw.indexOf(`"${name}"`);
        const line = idx === -1 ? 1 : file.raw.slice(0, idx).split('\n').length;
        prodScripts.push({ file, name, cmd: String(cmd), line });
      }
    }
  }
  const infra = [...dockerfiles, ...k8s, ...compose, ...platform, ...shell, ...ci];
  const has = (name) => deps.has(name);
  const hasAny = (re) => [...deps.keys()].some((n) => re.test(n));

  return {
    root, today, all, textFiles, code, src, dockerfiles, k8s, compose, ci, platform, shell, infra,
    pkgs, rootPkg, deps, prodDeps, ancestorFiles, installed, resolve, feature, has, hasAny, gitTracked, prodScripts,
    isNest: has('@nestjs/core') || has('@nestjs/common'),
    nestVersion: (() => {
      const r = resolve('@nestjs/core');
      if (!r) return null;
      return r.source === 'declared' ? `${r.spec} (declared, not installed)` : r.version;
    })(),
  };
}

// ───────────────────────── result builder ─────────────────────────

// `// preflight-ignore: 4 reason` (or `# preflight-ignore: 2`) on the flagged line or the line above
// suppresses that evidence for the listed check ids (all checks if no ids are given).
let FILE_INDEX = new Map();
function isSuppressed(e, id) {
  const f = FILE_INDEX.get(e.file);
  if (!f || !e.line) return false;
  const raw = f.raw.split('\n');
  for (const l of [raw[e.line - 1], raw[e.line - 2]]) {
    const m = l && l.match(/preflight-ignore(?::?\s*([\d,\s]+))?/);
    if (m) {
      if (!m[1] || !m[1].trim()) return true;
      if (m[1].split(/[\s,]+/).map(Number).includes(id)) return true;
    }
  }
  return false;
}

function builder(id) {
  const [, section, title] = CHECKS.find((c) => c[0] === id);
  const r = { id, section, title, status: null, findings: [], reference: REF_FILE[id] };
  const add = (level) => (message, evidence = []) => {
    const all = Array.isArray(evidence) ? evidence : [evidence];
    const list = all.filter((e) => !isSuppressed(e, id));
    if (all.length && !list.length && level !== 'info' && level !== 'pass') {
      r.findings.push({ level: 'info', message: `Suppressed by preflight-ignore: ${message}`, evidence: all.slice(0, MAX_EVIDENCE), more: 0 });
      return;
    }
    r.findings.push({ level, message, evidence: list.slice(0, MAX_EVIDENCE), more: Math.max(0, list.length - MAX_EVIDENCE) });
  };
  return {
    r,
    fail: add('fail'), warn: add('warn'), manual: add('manual'), pass: add('pass'), info: add('info'),
    na(message) { r.status = 'n/a'; r.findings.push({ level: 'info', message, evidence: [], more: 0 }); },
    finish(fallback = 'manual') {
      if (r.status) return r;
      let best = null;
      for (const f of r.findings) if (f.level !== 'info' && (!best || LEVEL_RANK[f.level] > LEVEL_RANK[best])) best = f.level;
      r.status = best || fallback;
      r.findings.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
      return r;
    },
  };
}

// Dockerfile instruction parser (handles `\` continuations, keeps start line)
function dockerInstructions(f) {
  const out = [];
  const lines = f.lines;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const start = i + 1;
    while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, ' ') + lines[++i];
    const m = line.match(/^\s*([A-Za-z]+)\s+(.*)$/);
    if (m) out.push({ op: m[1].toUpperCase(), args: m[2].trim(), line: start });
  }
  return out;
}
const hitAt = (f, line) => ({ file: f, line, index: 0, m: [''] });

// ─────────────────────────── the checks ───────────────────────────

const AUTHISH = /(auth|jwt|session|passport|clerk|firebase|keycloak|oidc|oauth|api[-_]?key|bearer|access|cognito|supabase|auth0|token|login|identity)/i;
const OUTBOUND_DEPS = /^(axios|@nestjs\/axios|@nestjs\/http-client|got|undici|node-fetch|ky|stripe|twilio|@sendgrid\/.+|@aws-sdk\/.+|aws-sdk|openai|@anthropic-ai\/sdk|@google-cloud\/.+|googleapis|@grpc\/grpc-js|@slack\/.+|@octokit\/.+|nodemailer|@mailchimp\/.+|resend|postmark|algoliasearch|@elastic\/elasticsearch)$/;
const DB_DEPS = /^(pg|postgres|typeorm|@prisma\/client|prisma|knex|drizzle-orm|@mikro-orm\/.+|sequelize|sequelize-typescript|mysql2?|mongoose|@nestjs\/mongoose|@nestjs\/typeorm|@nestjs\/sequelize|kysely|objection)$/;

function check1(ctx) {
  const b = builder(1);
  const cfg = find(ctx.src, /ConfigModule\.forRoot(Async)?\s*\(/);
  const valInCfg = find(uniqFiles(cfg), /\b(validationSchema\b|validate\s*[:,}])/);
  const valElsewhere = find(ctx.src, /\b(safeParse|parse)\s*\(\s*process\.env\b|\bcleanEnv\s*\(|\bvalidateSync\s*\(|\benvSchema\b/);
  if (valInCfg.length) b.pass('Config is validated at boot (ConfigModule validationSchema/validate).', ev(valInCfg));
  else if (valElsewhere.length) b.pass('Environment is validated at boot outside ConfigModule.', ev(valElsewhere));
  else if (cfg.length) b.fail('ConfigModule.forRoot() has no `validationSchema`/`validate` — a missing or malformed variable surfaces on first use in production, not at boot.', ev(cfg));
  else {
    const env = find(ctx.src, /process\.env\b/);
    if (env.length) b.fail('Reads `process.env` directly with no boot-time validation.', ev(dedupeLines(env)));
    else b.manual('No configuration loading detected — confirm how the app reads its settings.');
  }

  const gets = dedupeLines(find(ctx.src, /\b\w*config\w*\s*\.\s*get\s*(?:<[^>()]*>)?\s*\(/i));
  if (gets.length) b.warn(`${gets.length} \`config.get()\` call(s) — prefer \`getOrThrow()\` so a missing value fails loudly (calls with an explicit default are lower risk).`, ev(gets));

  const envFiles = ctx.all.filter((f) => /^\.env(\..+)?$/.test(f.base) && !/\.(example|sample|template|dist|defaults?|schema)$/.test(f.base));
  if (ctx.gitTracked) {
    const tracked = envFiles.filter((f) => ctx.gitTracked.has(f.rel));
    if (tracked.length) b.fail('`.env` file(s) are committed to git — secrets belong in the platform secret store.', tracked.map((f) => evFile(f)));
  } else if (envFiles.length) {
    const gi = ctx.all.find((f) => f.rel === '.gitignore');
    if (!gi || !/^\s*\/?\.env/m.test(gi.raw)) b.warn('`.env` file(s) present and not covered by .gitignore.', envFiles.map((f) => evFile(f)));
  }

  const dockerignore = ctx.all.find((f) => f.base === '.dockerignore');
  for (const d of ctx.dockerfiles) {
    for (const ins of dockerInstructions(d)) {
      if (ins.op === 'COPY' || ins.op === 'ADD') {
        if (/(^|\s)\.env\b/.test(ins.args)) b.fail('Dockerfile copies a `.env` file into the image.', ev([hitAt(d, ins.line)]));
        else if (/(^|\s)\.\s+\S+\s*$/.test(ins.args) && (!dockerignore || !/^\s*\**\/?\.env/m.test(dockerignore.raw))) {
          const dir = path.posix.dirname(d.rel);
          const beside = envFiles.filter((f) => dir === '.' || f.rel.startsWith(`${dir}/`));
          if (beside.length) b.fail(`\`COPY . …\` with no \`.dockerignore\` entry for \`.env*\`, and ${beside.map((f) => f.rel).join(', ')} exists — its contents are baked into an image layer.`, ev([hitAt(d, ins.line)]));
          else b.warn('`COPY . …` with no `.dockerignore` entry for `.env*` — local env files can end up in an image layer.', ev([hitAt(d, ins.line)]));
        }
      }
      if ((ins.op === 'ENV' || ins.op === 'ARG') && /\b\w*(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL|DSN)\w*\s*[= ]\s*\S+/i.test(ins.args)) {
        b.fail('Secret-looking value set with ENV/ARG — it is baked into the image layers and visible in `docker history`.', ev([hitAt(d, ins.line)]));
      }
    }
  }
  const logs = find(ctx.src, /\b(console\.(log|info|debug|dir)|(this\.)?logger\.(log|info|debug|verbose))\s*\(\s*(JSON\.stringify\s*\(\s*)?(this\.)?(config|configService|process\.env|env)\s*[,)]/);
  if (logs.length) b.warn('Whole config/env object is logged — this leaks credentials into log storage.', ev(logs));
  return b.finish();
}

function check2(ctx) {
  const b = builder(2);
  const hooks = find(ctx.src, /\.enableShutdownHooks\s*\(/);
  if (hooks.length) b.pass('`app.enableShutdownHooks()` is enabled.', ev(hooks));
  else if (ctx.isNest) b.fail('`app.enableShutdownHooks()` is not called — `onModuleDestroy`/`onApplicationShutdown` never run on SIGTERM, so connections and in-flight work are cut off.', ev(find(ctx.src, /NestFactory\.create\w*\s*[<(]/)));

  const procExit = find(ctx.src, /useProcessExit\s*:\s*true/);
  const initInfra = find(ctx.infra, /(--init\b|\btini\b|dumb-init|^\s*init:\s*true)/m);
  if (procExit.length || initInfra.length) b.pass('PID 1 signal handling is covered (init process or `useProcessExit`).', ev([...procExit, ...initInfra]));

  if (!ctx.dockerfiles.length) {
    b.manual('No Dockerfile found. If you deploy via buildpacks/PaaS, confirm the start command is `node dist/main.js` (not `npm start`), runs as non-root, and sets NODE_ENV=production.');
  }
  let sawHeap = find([...ctx.infra, ...ctx.pkgs.map((p) => p.file)], /max[-_]old[-_]space[-_]size/).length > 0;
  for (const d of ctx.dockerfiles) {
    const ins = dockerInstructions(d);
    const froms = ins.filter((i) => i.op === 'FROM');
    const lastFrom = froms.length ? froms[froms.length - 1].line : 0;
    const final = ins.filter((i) => i.line >= lastFrom);
    const cmd = [...final].reverse().find((i) => i.op === 'CMD');
    const entry = [...final].reverse().find((i) => i.op === 'ENTRYPOINT');
    const runner = entry || cmd;
    if (runner) {
      if (!runner.args.startsWith('[')) b.fail(`${runner.op} uses shell form — \`/bin/sh -c\` becomes PID 1 and does not forward SIGTERM to Node. Use exec form: CMD ["node", "dist/main.js"].`, ev([hitAt(d, runner.line)]));
      else if (/"(npm|yarn|pnpm|npx|bun)"/.test(runner.args)) b.warn(`${runner.op} starts the app through a package manager, which can swallow or delay signals. Run \`node\` directly.`, ev([hitAt(d, runner.line)]));
      else if (/tini|dumb-init/.test(runner.args)) b.pass('Init process used as entrypoint.', ev([hitAt(d, runner.line)]));
      else b.pass(`${runner.op} uses exec form.`, ev([hitAt(d, runner.line)]));
    } else {
      b.manual('No CMD/ENTRYPOINT in the final stage — confirm the base image starts Node in exec form.', [evFile(d)]);
    }
    if (froms.length < 2) b.warn('Single-stage build — dev dependencies and the TypeScript toolchain ship in the runtime image. Use a multi-stage build with `npm prune --omit=dev` or `npm ci --omit=dev`.', ev([hitAt(d, froms[0]?.line || 1)]));
    const user = [...final].reverse().find((i) => i.op === 'USER');
    if (!user || /^(root|0)(:|$)/.test(user.args)) b.warn('Final stage runs as root. Add `USER node` (or another unprivileged user).', ev([hitAt(d, user?.line || lastFrom || 1)]));
    const nodeEnv = final.find((i) => (i.op === 'ENV' || i.op === 'ARG') && /NODE_ENV\s*[= ]\s*["']?production/.test(i.args));
    if (!nodeEnv) b.warn('`NODE_ENV=production` is not set in the runtime stage.', ev([hitAt(d, lastFrom || 1)]));
    if (!procExit.length && !initInfra.length) b.warn('Node runs as PID 1 without an init process. Use `docker run --init` / `tini`, or `app.enableShutdownHooks(undefined, { useProcessExit: true })`.', ev([hitAt(d, runner?.line || 1)]));
  }
  if ((ctx.dockerfiles.length || ctx.k8s.length) && !sawHeap) {
    b.warn('No explicit heap limit. Set `NODE_OPTIONS="--max-old-space-size=<~75% of container memory in MB>"` so V8 collects before the OOM killer fires.');
  }
  return b.finish();
}

function check3(ctx) {
  const b = builder(3);
  const r503 = find(ctx.src, /return503OnClosing\s*:\s*true/);
  const avail = ctx.feature('return503OnClosing', ['@nestjs/core', '@nestjs/common']);
  if (r503.length) b.pass('`return503OnClosing: true` is enabled.', ev(r503));
  else if (avail === true) b.warn(`Your Nest version (${ctx.nestVersion}) supports \`return503OnClosing\` but it is not enabled — requests arriving during shutdown get connection errors instead of a retryable 503.`, ev(find(ctx.src, /NestFactory\.create\w*\s*[<(]/)));
  else if (avail === false) b.info(`\`return503OnClosing\` needs @nestjs/core ≥ 12.0 (you have ${ctx.nestVersion || 'unknown'}). Rely on a pre-stop delay for now.`);
  else b.info('Install dependencies to detect whether your Nest version supports `return503OnClosing`.');

  const workloads = ctx.k8s.filter((f) => /^\s*kind:\s*(Deployment|StatefulSet|Rollout)\b/m.test(f.text) || /containers\s*:/.test(f.text));
  if (workloads.length) {
    const pre = find(ctx.k8s, /preStop\s*:/);
    if (pre.length) b.pass('Kubernetes `preStop` hook present (delay before SIGTERM so endpoints can be removed).', ev(pre));
    else b.warn('No `preStop` delay — the pod gets SIGTERM while load balancers may still route to it. Add `lifecycle.preStop.exec.command: ["sleep", "5"]`.', workloads.map((f) => evFile(f)));
    const tgps = find(ctx.k8s, /terminationGracePeriodSeconds\s*:\s*(\d+)/);
    if (tgps.length) b.info(`terminationGracePeriodSeconds: ${tgps.map((h) => h.m[1]).join(', ')} — the preStop delay counts against it; it must also cover your longest request or job.`, ev(tgps));
    else b.info('terminationGracePeriodSeconds not set (Kubernetes default 30s). The preStop delay counts against it; make sure it covers your longest request or job.');
  } else {
    b.manual('No Kubernetes workloads found. Confirm your platform stops routing to an instance before sending SIGTERM (or add a short delay), and that its grace period covers your longest request/job.');
  }
  return b.finish();
}

function check4(ctx) {
  const b = builder(4);
  const sched = find(ctx.src, /@(Cron|Interval|Timeout)\s*\(/);
  if (!sched.length) { b.na('No @Cron/@Interval/@Timeout handlers found.'); return b.finish(); }
  const LOCK = /(pg_try_advisory(_xact)?_lock|pg_advisory(_xact)?_lock|redlock|Redlock|\.acquire(Lock)?\s*\(|withLock\s*\(|LocksService|runExclusive|tryLock\s*\(|\.using\s*\(\s*\[|['"]NX['"]|\bsetnx\s*\(|\bSET\b[^\n]*\bNX\b|\bnx\s*:\s*true|\b\w*[lL]ock\w*\.(claim|acquire|tryAcquire|try)\w*\s*\()/;
  const guarded = []; const unguarded = [];
  for (const h of sched) {
    const around = h.file.window(h.line, 6, 3);
    const body = h.file.window(h.line, 0, 40);
    (/@(OnOneInstance|WithoutOverlapping)\b/.test(around) || LOCK.test(body) ? guarded : unguarded).push(h);
  }
  if (unguarded.length) b.fail(`${unguarded.length} scheduled handler(s) run on every replica (and twice during a rolling deploy). Guard with \`@OnOneInstance()\` / \`@WithoutOverlapping()\` from @nestjs/locks backed by Redis/Postgres, or a distributed lock.`, ev(unguarded, (h) => `@${h.m[1]}`));
  if (guarded.length) b.pass(`${guarded.length} scheduled handler(s) are lock-guarded.`, ev(guarded));
  const mem = find(ctx.src, /allowInMemoryStorage\s*:\s*true/);
  if (mem.length) b.warn('`allowInMemoryStorage: true` — the in-memory lock store only excludes callers in the same process; it does not coordinate replicas.', ev(mem));
  if (sched.some((h) => h.m[1] === 'Timeout')) b.info('@Timeout handlers run once per process start — i.e. once per replica on every deploy.');
  b.info('Jobs should process current state (e.g. "all unsent emails") rather than assume every tick ran — ticks are skipped during deploys and lock contention.');
  return b.finish();
}

function check5(ctx) {
  const b = builder(5);
  const globals = [];
  for (const h of find(ctx.src, /\bAPP_GUARD\b/)) {
    const t = h.file.text;
    const open = t.lastIndexOf('{', h.index);
    const close = t.indexOf('}', h.index);
    if (open === -1 || close === -1) continue;
    const m = t.slice(open, close).match(/use(?:Class|Existing)\s*:\s*(\w+)/);
    if (m && AUTHISH.test(m[1])) globals.push({ ...h, name: m[1] });
  }
  for (const h of find(ctx.src, /useGlobalGuards\s*\(/)) {
    const a = argsOf(h);
    if (AUTHISH.test(a)) globals.push({ ...h, name: a.trim() });
  }
  const authModule = find(ctx.src, /\bAuthenticationModule\b/);
  const perRoute = find(ctx.src, /@UseGuards\s*\(/).filter((h) => AUTHISH.test(argsOf(h)));
  const publics = find(ctx.src, /@(Public|AllowAnonymous|SkipAuth|IsPublic|NoAuth)\s*\(/);

  if (globals.length || (authModule.length && ctx.has('@nestjs/authentication'))) {
    b.pass('A global authentication guard is registered — routes are deny-by-default.', ev([...globals, ...authModule].slice(0, 4)));
    if (publics.length) b.manual(`${publics.length} route(s)/controller(s) opt out with a public decorator — review each one; this list *is* your unauthenticated surface.`, ev(publics));
  } else if (perRoute.length) {
    b.fail(`Auth is opt-in: ${perRoute.length} \`@UseGuards(...)\` usage(s) but no global auth guard. Any route that forgets the decorator is public. Register the guard with \`APP_GUARD\` and mark exceptions with \`@Public()\`.`, ev(perRoute));
    const unguarded = [];
    for (const f of ctx.src.filter((x) => /@Controller\s*\(/.test(x.text))) {
      const classGuarded = /@UseGuards\s*\([^)]*\)\s*(?:@\w+\s*\([^)]*\)\s*)*export\s+class|@Controller\s*\([^)]*\)\s*(?:@\w+\s*\([^)]*\)\s*)*@UseGuards/.test(f.text) && perRoute.some((h) => h.file === f);
      if (classGuarded) continue;
      for (const h of find([f], /@(Get|Post|Put|Patch|Delete|All)\s*\(/)) {
        const around = f.window(h.line, 4, 4);
        if (!(/@UseGuards\s*\(/.test(around) && AUTHISH.test(around)) && !/@(Public|AllowAnonymous|SkipAuth|IsPublic|NoAuth)\s*\(/.test(around)) unguarded.push(h);
      }
    }
    if (unguarded.length) b.fail(`${unguarded.length} route(s) have no auth guard at all — these are public right now.`, ev(unguarded, (h) => h.m[1].toUpperCase()));
  } else {
    b.warn('No authentication guard found. Fine only if this service is never reachable except through another authenticated layer — confirm.');
  }
  return b.finish();
}

function check6(ctx) {
  const b = builder(6);
  const headers = find(ctx.src, /(useSecurityHeaders\s*\(|\bhelmet\s*\(|@fastify\/helmet|fastifyHelmet)/);
  if (headers.length) b.pass('Security headers are set.', ev(headers));
  else {
    const avail = ctx.feature('useSecurityHeaders', ['@nestjs/core', '@nestjs/common']);
    b.warn(`No security headers (CSP, HSTS, X-Content-Type-Options…). ${avail ? 'Your Nest version has `app.useSecurityHeaders()` — call it.' : 'Use `helmet` (or `app.useSecurityHeaders()` once on @nestjs/core ≥ 12.1).'}`, ev(find(ctx.src, /NestFactory\.create\w*\s*[<(]/)));
  }

  const corsTrue = find(ctx.src, /\bcors\s*:\s*true\b/);
  const WILDCARD = 'sends `Access-Control-Allow-Origin: *` — any site can read non-credentialed responses. Pass an explicit origin allow-list.';
  const REFLECT = '`origin: true` reflects whatever origin asks — with `credentials: true` any website can make authenticated requests as your users. Use an explicit allow-list.';
  if (corsTrue.length) b.warn(`\`cors: true\` ${WILDCARD}`, ev(corsTrue));
  const corsReflect = find(ctx.src, /\bcors\s*:\s*\{[^}]*origin\s*:\s*true\b/);
  if (corsReflect.length) b.fail(REFLECT, ev(corsReflect));
  const corsWild = find(ctx.src, /\bcors\s*:\s*\{[^}]*origin\s*:\s*['"`]\*['"`]/);
  if (corsWild.length) b.warn(`CORS origin \`'*'\` ${WILDCARD}`, ev(corsWild));
  for (const h of find(ctx.src, /\.enableCors\s*\(/)) {
    const a = argsOf(h).trim();
    if (!a) b.warn(`\`enableCors()\` with no options ${WILDCARD}`, ev([h]));
    else if (/origin\s*:\s*true\b/.test(a)) b.fail(REFLECT, ev([h]));
    else if (/origin\s*:\s*['"`]\*['"`]/.test(a)) b.warn(`\`enableCors\` origin \`'*'\` ${WILDCARD}`, ev([h]));
    else if (/origin\s*:/.test(a)) b.pass('CORS is restricted to explicit origins.', ev([h]));
    else b.manual('`enableCors` is configured from a variable — confirm `origin` is an explicit allow-list.', ev([h]));
  }

  if (ctx.has('@nestjs/throttler') || find(ctx.src, /ThrottlerModule/).length) {
    const guard = find(ctx.src, /ThrottlerGuard/);
    if (guard.length) b.pass('Rate limiting via @nestjs/throttler with a guard.', ev(guard.slice(0, 3)));
    else b.warn('ThrottlerModule is configured but `ThrottlerGuard` is never applied.', ev(find(ctx.src, /ThrottlerModule/)));
  } else {
    b.warn('No rate limiting. At minimum protect login, signup, password reset and other expensive endpoints (ThrottlerModule + ThrottlerGuard).');
  }

  const tp = find(ctx.src, /['"]trust proxy['"]\s*,\s*([^)]+)\)|trustProxy\s*:\s*([^,}\n]+)/);
  if (tp.length) {
    for (const h of tp) {
      const v = (h.m[1] || h.m[2] || '').trim();
      if (v === 'true') b.warn('`trust proxy` is `true` — any client can spoof `X-Forwarded-For`. Set it to the actual hop count (e.g. `1`).', ev([h]));
      else b.pass(`\`trust proxy\` set to ${v}.`, ev([h]));
    }
  } else {
    b.warn('`trust proxy` is not set. Behind a load balancer/ingress, `req.ip` and `req.protocol` are the proxy\'s — rate limits key on one IP and secure cookies misbehave. Set it to your real hop count.');
  }
  return b.finish();
}

function check7(ctx) {
  const b = builder(7);
  const globalPipe = find(ctx.src, /useGlobalPipes\s*\(|provide\s*:\s*APP_PIPE/);
  const schemaPipe = find(ctx.src, /StandardSchemaValidationPipe|ZodValidationPipe|ValibotValidationPipe|createZodValidationPipe/);
  if (!globalPipe.length) {
    b.fail('No global validation pipe. Register `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` (or `StandardSchemaValidationPipe`) in main.ts.', ev(find(ctx.src, /NestFactory\.create\w*\s*[<(]/)));
  } else {
    const files = new Set(uniqFiles(globalPipe));
    const vps = find(ctx.src, /new\s+ValidationPipe\s*\(/).filter((h) => files.has(h.file));
    for (const h of vps) {
      const a = argsOf(h);
      if (!/whitelist\s*:\s*true/.test(a)) b.warn('Global ValidationPipe without `whitelist: true` — unknown properties pass straight through to your services (mass assignment).', ev([h]));
      else if (!/forbidNonWhitelisted\s*:\s*true/.test(a)) b.warn('Global ValidationPipe strips unknown properties silently; add `forbidNonWhitelisted: true` so clients learn about typos.', ev([h]));
      else b.pass('Global ValidationPipe with whitelist + forbidNonWhitelisted.', ev([h]));
    }
    const sp = schemaPipe.filter((h) => files.has(h.file));
    if (sp.length) b.pass('Global Standard Schema/Zod validation pipe. Use strict objects (e.g. `z.strictObject`) to reject unknown keys.', ev(sp));
    if (!vps.length && !sp.length) b.manual('A global pipe is registered but its type/options could not be read — confirm it validates and whitelists.', ev(globalPipe));
  }

  for (const h of find(ctx.src, /limit\s*:\s*['"`]?(\d+)\s*(mb|gb)\b/i)) {
    const n = Number(h.m[1]) * (h.m[2].toLowerCase() === 'gb' ? 1024 : 1);
    if (n >= 5) b.warn(`Body limit raised to ${h.m[1]}${h.m[2]} — every client can now make the server buffer that much per request. Keep the default and stream large uploads on dedicated routes.`, ev([h]));
  }
  for (const h of find(ctx.src, /bodyLimit\s*:\s*([\d_*\s]+)/)) {
    let n = 0;
    try { n = Function(`return (${h.m[1].replace(/_/g, '')})`)(); } catch { /* ignore */ }
    if (n >= 5 * 1024 * 1024) b.warn(`Fastify bodyLimit raised to ${Math.round(n / 1048576)}MB.`, ev([h]));
  }

  const untyped = find(ctx.src, /@Body\s*\(\s*\)\s*\w+\s*\??\s*:\s*(any|object|unknown|Record<[^>]*>)(?=[\s,)])/);
  if (untyped.length) b.warn(`${untyped.length} handler(s) take \`@Body()\` typed as any/object/unknown — the global pipe has no DTO to validate against, so anything goes through.`, ev(untyped));

  const dtoFiles = ctx.src.filter((f) => /(dto|query|pagination|paging|params|args)/i.test(f.rel));
  const pageProps = find(dtoFiles, /^[ \t]*(?:@\w+[ \t]*\([^)\n]*\)[ \t]*)*(?:readonly\s+)?(limit|take|pageSize|perPage|per_page|page_size|first)\s*[?!]?\s*:/m);
  const unbounded = pageProps.filter((h) => !/@Max\s*\(|\.max\s*\(|\bmaximum\s*:|\.lte\s*\(|Max\(/.test(h.file.window(h.line, 6, 1)));
  if (unbounded.length) b.warn(`${unbounded.length} pagination field(s) without an upper bound — \`?limit=1000000\` loads everything. Add \`@Max(100)\` / \`.max(100)\` and a default.`, ev(unbounded));
  else if (pageProps.length) b.pass('Pagination fields are bounded.', ev(pageProps.slice(0, 3)));
  return b.finish();
}

function check8(ctx) {
  const b = builder(8);
  for (const h of find(ctx.src, /SwaggerModule\.setup\s*\(/)) {
    if (/\b(NODE_ENV|isProd\w*|production|\w*SWAGGER_\w*|ENABLE_SWAGGER|swaggerEnabled|enableSwagger|ENABLE_DOCS|DOCS_ENABLED|docsEnabled|enableDocs)\b/.test(h.file.window(h.line, 15, 0))) {
      b.pass('Swagger setup is conditional on environment/config.', ev([h]));
    } else {
      b.warn('Swagger UI and the full OpenAPI schema are served in every environment. Disable it in production or put it behind auth.', ev([h]));
    }
  }
  const entityFiles = ctx.src.filter((f) => /@Entity\s*\(|@Schema\s*\(|@ObjectType\s*\(|@Table\s*\(/.test(f.text));
  const SENSITIVE = /^[ \t]*(?:@\w+[ \t]*\([^)\n]*\)[ \t]*)*(?:readonly\s+|public\s+|private\s+)?(password|passwordHash|password_hash|hashedPassword|passwordDigest|salt|secret|mfaSecret|totpSecret|twoFactorSecret|refreshToken|resetToken|resetPasswordToken|verificationToken|apiKey|api_key|privateKey)\s*[?!]?\s*:/im;
  const sensitive = find(entityFiles, new RegExp(SENSITIVE.source, 'gim'));
  const risky = sensitive.filter((h) => !/@Exclude\s*\(|select\s*:\s*false|@HideField\s*\(/.test(h.file.window(h.line, 5, 0)) && !/toJSON\s*\(/.test(h.file.text));
  if (sensitive.length && !risky.length) b.pass('Sensitive entity fields are excluded from serialization.', ev(sensitive, (h) => h.m[1]));
  if (risky.length) b.warn(`${risky.length} sensitive field(s) on ORM entities with no \`@Exclude()\` / \`select: false\`. If a handler ever returns the entity, the field goes on the wire. Map to response DTOs or exclude + ClassSerializerInterceptor.`, ev(risky, (h) => h.m[1]));
  const prisma = ctx.textFiles.filter((f) => f.ext === '.prisma');
  const prismaRisky = find(prisma, /^\s*(password\w*|salt|secret\w*|\w*Token|apiKey)\s+String/gim);
  if (prismaRisky.length) b.manual('Prisma models have sensitive fields — Prisma returns every scalar by default. Confirm handlers use `select`/`omit` or map to DTOs.', ev(prismaRisky));
  const serializer = find(ctx.src, /ClassSerializerInterceptor|plainToInstance\s*\(|toResponseDto|ResponseDto\b|@SerializeOptions/);
  if (serializer.length) b.pass('Response serialization/DTO mapping in use.', ev(serializer.slice(0, 3)));
  if (!b.r.findings.length) b.manual('Review a few controllers: do handlers return ORM entities directly? Response shapes should be deliberate, not whatever the entity has today.');
  return b.finish();
}

function check9(ctx) {
  const b = builder(9);
  const infra = find(ctx.src, /IdempotencyModule|@Idempotent\b|idempotency[-_]?key/i);
  const RISKY = /(pay|charge|order|checkout|transfer|refund|payout|invoice|purchase|subscri|booking|reserve|withdraw|deposit|capture|donat|topup|top-up|credit|debit|wallet|transaction)/i;
  const risky = []; const guarded = [];
  for (const f of ctx.src.filter((x) => /@Controller\s*\(/.test(x.text))) {
    const prefix = (f.text.match(/@Controller\s*\(\s*(?:\{[^}]*path\s*:\s*)?['"`]([^'"`]*)/) || [])[1] || '';
    for (const h of find([f], /@Post\s*\(\s*(?:['"`]([^'"`]*)['"`])?/)) {
      let name = '';
      for (let i = h.line; i < Math.min(f.lines.length, h.line + 8); i++) {
        const l = f.lines[i];
        if (/^\s*@/.test(l)) continue;
        const m = l.match(/^\s*(?:public\s+|async\s+)*(\w+)\s*\(/);
        if (m) { name = m[1]; break; }
      }
      const label = `${prefix}/${h.m[1] || ''} ${name}`;
      if (!RISKY.test(label)) continue;
      (/@Idempotent\b/.test(f.window(h.line, 6, 6)) ? guarded : risky).push({ ...h, label });
    }
  }
  if (risky.length) b.warn(`${risky.length} payment-like POST endpoint(s) without idempotency. A client retry after a timeout can charge/order twice. Support \`Idempotency-Key\` (e.g. @nestjs/idempotency with a shared Redis/Postgres store and \`@Idempotent({ required: true })\`).`, ev(risky, (h) => `POST ${h.label.trim()}`));
  if (guarded.length) b.pass(`${guarded.length} risky endpoint(s) are idempotent.`, ev(guarded));
  if (!risky.length && infra.length) b.pass('Idempotency support present.', ev(infra.slice(0, 3)));
  if (!b.r.findings.length) b.manual('No obviously payment-like POST endpoints detected. Confirm that no write a client might retry (after a timeout or network blip) can be applied twice.');
  return b.finish();
}

function nodeVerdict(major, today) {
  if (major == null) return null;
  const line = NODE_LINES[major];
  if (!line) {
    if (major % 2 === 1) return { level: 'warn', msg: `Node ${major} is an odd-numbered (non-LTS) release.` };
    return { level: 'manual', msg: `Node ${major} is newer than this scanner's release table — verify its LTS status at nodejs.org.` };
  }
  const eol = new Date(`${line.eol}T00:00:00Z`);
  const lts = new Date(`${line.lts}T00:00:00Z`);
  if (today > eol) return { level: 'fail', msg: `Node ${major} reached end-of-life on ${line.eol} — no more security fixes.` };
  if (today < lts) return { level: 'warn', msg: `Node ${major} is a "Current" release until LTS starts ${line.lts} — production should run Active or Maintenance LTS.` };
  const left = daysBetween(today, eol);
  if (left < 120) return { level: 'warn', msg: `Node ${major} reaches end-of-life on ${line.eol} (${left} days) — plan the upgrade.` };
  return { level: 'pass', msg: `Node ${major} is a supported LTS line (EOL ${line.eol}).` };
}

function check10(ctx) {
  const b = builder(10);
  const nodePins = [];
  for (const h of find(ctx.dockerfiles, /^\s*FROM\s+(?:--platform=\S+\s+)?(?:[\w.\-/:]+\/)?node(?::([\w.-]+))?(?:@\S+)?(?:\s|$)/im)) {
    const tag = h.m[1];
    if (!tag || /^(latest|current|alpine|slim|bookworm|bullseye)$/.test(tag)) b.warn(`Base image \`node${tag ? `:${tag}` : ''}\` is not pinned to a major version.`, ev([h]));
    else if (/^lts/.test(tag)) b.info('Base image tracks `node:lts` — pin a major so upgrades are deliberate.', ev([h]));
    else nodePins.push({ major: majorOf(tag), hit: h, source: 'Dockerfile' });
  }
  const pinFiles = [...ctx.all.filter((x) => ['.nvmrc', '.node-version', '.tool-versions', 'mise.toml', '.mise.toml'].includes(x.base)), ...ctx.ancestorFiles.filter((x) => ['.nvmrc', '.node-version', '.tool-versions', 'mise.toml', '.mise.toml'].includes(x.base)).map((x) => makeFile(ctx.root, x.abs))];
  for (const f of pinFiles) {
    const m = ['.nvmrc', '.node-version'].includes(f.base) ? f.raw.trim().match(/^v?(\d+)/) : f.raw.match(/^\s*node(?:js)?\s*(?:=\s*)?['"]?v?(\d+)/m);
    if (m) nodePins.push({ major: Number(m[1]), hit: hitAt(f, f.raw.slice(0, m.index).split('\n').length), source: f.rel });
  }
  for (const h of find(ctx.ci, /node[-_]version\s*:\s*\[?\s*['"]?v?(\d+)/)) nodePins.push({ major: Number(h.m[1]), hit: h, source: 'CI' });
  const seen = new Set();
  for (const p of nodePins) {
    const key = `${p.major}|${p.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = nodeVerdict(p.major, ctx.today);
    if (v) b[v.level](`${v.msg} (${p.source})`, ev([p.hit]));
  }
  if (!nodePins.length) b.warn('Node version is not pinned (Dockerfile, .nvmrc or CI) — production may run whatever the platform defaults to.');
  if (ctx.rootPkg.engines?.node) b.info(`package.json engines.node: \`${ctx.rootPkg.engines.node}\`.`);

  const CORE = ['@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/platform-fastify', '@nestjs/testing', '@nestjs/microservices', '@nestjs/websockets', '@nestjs/platform-socket.io', '@nestjs/platform-ws'];
  const present = CORE.filter((n) => ctx.has(n)).map((n) => ({ n, v: ctx.installed(n) }));
  if (present.length) {
    const majors = new Set(present.map((p) => majorOf(p.v)));
    const exact = new Set(present.map((p) => p.v));
    const list = present.map((p) => `${p.n}@${p.v}`).join(', ');
    if (majors.size > 1) b.fail(`@nestjs/* core packages are on different majors: ${list}.`);
    else if (exact.size > 1) b.warn(`@nestjs/* core packages are not aligned: ${list}. Keep them on the same version.`);
    else b.pass(`@nestjs/* core packages aligned at ${present[0].v}.`);
  }

  const lockfiles = ctx.all.filter((f) => ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json'].includes(f.base) && !f.rel.includes('/node_modules/'));
  const rootLocks = lockfiles.filter((f) => !f.rel.includes('/'));
  const upLocks = ctx.ancestorFiles.filter((f) => /lock|shrinkwrap/.test(f.base));
  if (!lockfiles.length && upLocks.length) b.pass(`Lockfile at the workspace root (${upLocks[0].rel}).`);
  else if (!lockfiles.length) b.fail('No lockfile committed — every build can resolve different dependency versions.');
  else if (rootLocks.length > 1) b.warn(`Multiple lockfiles at the root (${rootLocks.map((f) => f.base).join(', ')}) — pick one package manager.`);
  else if (ctx.gitTracked && !lockfiles.some((f) => ctx.gitTracked.has(f.rel))) b.fail('Lockfile exists but is not committed.', lockfiles.map((f) => evFile(f)));
  else b.pass(`Lockfile present (${lockfiles[0].base}).`);

  const installs = find([...ctx.dockerfiles, ...ctx.ci], /\b(npm\s+(?:install|i)\b(?![^\n]*(-g\b|--global|--package-lock-only))|yarn\s+install\b(?![^\n]*(--frozen-lockfile|--immutable)))/);
  if (installs.length) b.warn('Builds use `npm install`/`yarn install` — use `npm ci` (or a frozen-lockfile install) so CI and production get exactly the lockfile.', ev(installs));
  const ci = find([...ctx.dockerfiles, ...ctx.ci], /\bnpm\s+ci\b|--frozen-lockfile|--immutable/);
  if (ci.length && !installs.length) b.pass('Reproducible installs (`npm ci` / frozen lockfile).', ev(ci.slice(0, 2)));

  const audit = find(ctx.ci, /\b(npm|pnpm|yarn)\s+(npm\s+)?audit\b|snyk|osv-scanner|audit-ci|trivy|grype|socket\s+(ci|scan)/);
  if (audit.length) b.pass('Dependency audit runs in CI.', ev(audit.slice(0, 2)));
  else b.warn('No dependency audit in CI. Add `npm audit --omit=dev` (or equivalent).');
  const bots = [...ctx.all.filter((f) => /^(renovate\.json5?|\.renovaterc(\.json)?|\.github\/renovate\.json5?|\.github\/dependabot\.ya?ml)$/.test(f.rel)), ...ctx.ancestorFiles.filter((f) => f.base === 'renovate.json')];
  if (bots.length || ctx.rootPkg.renovate) b.pass('Automated dependency updates configured.', bots.map((f) => evFile(f)));
  else b.warn('No Renovate/Dependabot config — small continuous updates beat one painful upgrade a year.');
  if (ctx.nestVersion) b.info(`@nestjs/core: ${ctx.nestVersion}.`);
  return b.finish();
}

function outboundSignals(ctx) {
  const pkgOf = (spec) => spec.replace(/^(@[^/]+\/[^/]+|[^/]+).*$/, '$1');
  const sdkImports = find(ctx.src, /(?:from\s+|require\s*\(\s*)['"]([^'"./][^'"]*)['"]/).filter((h) => OUTBOUND_DEPS.test(pkgOf(h.m[1])) && !/^(axios|@nestjs\/axios|@nestjs\/http-client)$/.test(pkgOf(h.m[1])));
  const fetches = find(ctx.src, /(?<![\w.$])fetch\s*\(/);
  const axiosRaw = find(ctx.src, /\baxios\s*\.\s*(get|post|put|patch|delete|request|head)\s*\(|\baxios\s*\(/);
  const httpModule = find(ctx.src, /\bHttpModule\.register(Async)?\s*\(/);
  const httpClient = find(ctx.src, /\bHttpClientModule\.register(Async)?\s*\(/);
  const axiosCreate = find(ctx.src, /\baxios\.create\s*\(/);
  const sdkDeps = [...new Set(sdkImports.map((h) => pkgOf(h.m[1])))];
  const callSites = [...fetches, ...axiosRaw, ...httpModule, ...httpClient, ...axiosCreate, ...sdkImports];
  return { fetches, axiosRaw, httpModule, httpClient, axiosCreate, sdkDeps, callSites, any: callSites.length > 0 };
}

function check11(ctx) {
  const b = builder(11);
  const o = outboundSignals(ctx);
  const noSignal = o.fetches.filter((h) => !/\bsignal\b/.test(argsOf(h)));
  if (noSignal.length) b.warn(`${noSignal.length} \`fetch()\` call(s) without a \`signal\` — fetch has no default timeout and can hang forever. Pass \`signal: AbortSignal.timeout(5_000)\`.`, ev(noSignal));
  else if (o.fetches.length) b.pass('All `fetch()` calls pass a signal.', ev(o.fetches.slice(0, 3)));
  for (const [hits, label] of [[o.httpModule, 'HttpModule.register'], [o.axiosCreate, 'axios.create'], [o.httpClient, 'HttpClientModule.register']]) {
    const missing = hits.filter((h) => !/\btimeout\b/.test(argsOf(h)));
    if (missing.length) b.warn(`\`${label}()\` without a \`timeout\` (axios defaults to none).`, ev(missing));
    else if (hits.length) b.pass(`\`${label}()\` sets a timeout.`, ev(hits.slice(0, 2)));
  }
  if (o.axiosRaw.length && !find(ctx.src, /axios\.defaults\.timeout/).length) b.warn(`${o.axiosRaw.length} call(s) on the global axios instance with no default timeout.`, ev(o.axiosRaw));
  const usesDb = [...ctx.deps.keys()].some((n) => DB_DEPS.test(n));
  if (usesDb) {
    const t = find(ctx.textFiles.filter((f) => !f.rel.includes('node_modules')), /statement_timeout|statementTimeout|query_timeout|queryTimeout|maxExecutionTime|max_execution_time|socketTimeoutMS|maxTimeMS|requestTimeout/);
    if (t.length) b.pass('Database query timeout configured.', ev(t.slice(0, 3)));
    else b.warn('No database statement/query timeout found. One slow query can pin a pool connection indefinitely (Postgres: `statement_timeout`).');
  }
  b.info('Budget timeouts against retries: 3 attempts × 5s is a 15s+ request.');
  if (!o.any && !usesDb) { b.r.findings = []; b.na('No outbound HTTP clients or database drivers detected.'); }
  return b.finish();
}

function check12(ctx) {
  const b = builder(12);
  const o = outboundSignals(ctx);
  const libs = [...ctx.deps.keys()].filter((n) => /^(@nestjs\/resilience|opossum|cockatiel|mollitia|brakes|@hapi\/wreck|p-retry|async-retry|axios-retry)$/.test(n));
  const usage = find(ctx.src, /@Resilience\s*\(|@CircuitBreaker|@Bulkhead\s*\(|@Fallback\s*\(|new\s+CircuitBreaker\s*\(|circuitBreaker\s*\(|ResilienceService/);
  const breakers = libs.filter((n) => !/retry/.test(n));
  if (breakers.length || usage.length) {
    b.pass(`Resilience tooling in use (${[...libs].join(', ') || 'decorators'}).`, ev(usage.slice(0, 4)));
    b.manual('Confirm each critical dependency has a timeout, a circuit breaker, a bulkhead (concurrency cap) and a fallback, and that the injected abort `signal` reaches the actual I/O call.');
  } else if (libs.length) {
    b.warn(`Only retries (${libs.join(', ')}) — no circuit breaker or bulkhead. Retries alone amplify load on a dependency that is already down.`);
  } else if (o.any) {
    b.warn(`Outbound calls (${[...o.sdkDeps].slice(0, 6).join(', ') || 'HTTP'}) with no circuit breaker, bulkhead or fallback. When one is down, requests pile up waiting on it. Consider @nestjs/resilience (Nest 12) or opossum/cockatiel.`, ev(o.callSites));
  } else {
    b.na('No outbound dependencies detected.');
  }
  return b.finish();
}

function check13(ctx) {
  const b = builder(13);
  const orm = [...ctx.deps.keys()].filter((n) => /^(typeorm|@nestjs\/typeorm|prisma|@prisma\/client|drizzle-orm|drizzle-kit|knex|@mikro-orm\/.+|sequelize|sequelize-typescript|kysely)$/.test(n));
  if (!orm.length) { b.na('No SQL ORM / migration tool detected.'); return b.finish(); }
  const syncTrue = find(ctx.src, /\bsynchronize\s*:\s*true\b/);
  if (syncTrue.length) b.fail('`synchronize: true` — the ORM rewrites the schema on boot, can drop columns and data, and races across replicas.', ev(syncTrue));
  const syncDyn = find(ctx.src, /\bsynchronize\s*:(?!\s*(?:true|false)\b)\s*[^,}\n]+/);
  if (syncDyn.length) b.warn('`synchronize` is set from an expression — verify it is always false in production.', ev(syncDyn));
  const seqSync = find(ctx.src, /\.sync\s*\(\s*\{[^}]*(alter|force)\s*:\s*true/);
  if (seqSync.length) b.fail('`sequelize.sync({ alter/force })` rewrites the schema at runtime.', ev(seqSync));
  const migRun = find(ctx.src, /\bmigrationsRun\s*:\s*true\b/);
  if (migRun.length) b.warn('`migrationsRun: true` runs migrations inside app startup — every replica races to run them, and a slow migration fails health checks. Run them as a separate pre-deploy step.', ev(migRun));

  const PUSH = /\b(prisma\s+db\s+push|drizzle-kit\s+push|db:push)\b/;
  const MIGRATE = /\b(prisma\s+migrate\s+deploy|migration:run|drizzle-kit\s+migrate|migrate:latest|migration:up|db:migrate|mikro-orm\s+migration|migrate)\b/;
  const runtimeFiles = [...ctx.dockerfiles, ...ctx.k8s, ...ctx.compose, ...ctx.platform, ...ctx.shell, ...ctx.ci];
  const pushInfra = find(runtimeFiles, new RegExp(PUSH.source, 'g'));
  const pushScripts = ctx.prodScripts.filter((s) => PUSH.test(s.cmd));
  if (pushInfra.length || pushScripts.length) b.fail('Schema push (`prisma db push` / `drizzle-kit push`) in a deploy path — it applies unreviewed diffs straight to production.', [...ev(pushInfra), ...pushScripts.map((s) => ({ file: s.file.rel, line: s.line, snippet: redact(`"${s.name}": "${s.cmd}"`) }))]);

  const bootMigrate = [];
  for (const d of ctx.dockerfiles) for (const i of dockerInstructions(d)) if ((i.op === 'CMD' || i.op === 'ENTRYPOINT') && MIGRATE.test(i.args)) bootMigrate.push({ file: d.rel, line: i.line, snippet: `${i.op} ${i.args}`.slice(0, 180) });
  for (const s of ctx.prodScripts.filter((x) => /start|serve|launch/.test(x.name) && MIGRATE.test(x.cmd))) bootMigrate.push({ file: s.file.rel, line: s.line, snippet: redact(`"${s.name}": "${s.cmd}"`) });
  for (const f of ctx.shell) if (MIGRATE.test(f.text) && /\b(exec\s+)?node\b/.test(f.text)) bootMigrate.push({ file: f.rel, line: 1, snippet: 'entrypoint script runs migrations then starts node' });
  const initC = find(ctx.k8s, /initContainers\s*:/).filter((h) => MIGRATE.test(h.file.window(h.line, 0, 30)));
  if (bootMigrate.length) b.warn('Migrations run as part of app startup — every replica runs them on every restart. Move them to a single pre-deploy job/release phase.', bootMigrate);
  if (initC.length) b.warn('Migrations in an initContainer run once per pod, not once per deploy. Use a Job/Helm pre-upgrade hook instead.', ev(initC));

  const proper = [
    ...find(ctx.k8s, /helm\.sh\/hook\s*:\s*['"]?[\w,-]*pre-(install|upgrade)/).filter((h) => MIGRATE.test(h.file.text)),
    ...find(ctx.k8s, /^\s*kind:\s*Job\b/m).filter((h) => MIGRATE.test(h.file.text)),
    ...find(ctx.platform, /^\s*release\s*:|release_command|preDeployCommand|release\s*=/m).filter((h) => MIGRATE.test(h.file.window(h.line, 0, 2))),
    ...find(ctx.ci, new RegExp(MIGRATE.source, 'g')),
  ];
  if (proper.length) b.pass('Migrations run as a separate deploy step.', ev(dedupeLines(proper).slice(0, 4)));
  if (!b.r.findings.some((f) => f.level !== 'info')) b.manual(`Could not find where migrations run (${orm.join(', ')}). They should be reviewed files applied by one pre-deploy job.`);
  b.info('Each migration must work with the version still running (expand → deploy → contract). Rollback = redeploy the previous image, so it must tolerate the new schema.');
  return b.finish();
}

function check14(ctx) {
  const b = builder(14);
  const usesDb = [...ctx.deps.keys()].some((n) => DB_DEPS.test(n));
  if (!usesDb) { b.na('No database driver detected.'); return b.finish(); }
  const poolFiles = ctx.src.filter((f) => /(TypeOrmModule|DataSource|new\s+Pool\s*\(|knex\s*\(|\bpool\s*:|\bextra\s*:|MikroOrmModule|SequelizeModule|createPool|drizzle\s*\(|PrismaClient|MongooseModule)/.test(f.text));
  const sizes = [
    ...find(poolFiles, /\b(max|poolSize|connectionLimit|maxPoolSize|pool_max|maxConnections)\s*:\s*(\d+)/),
    ...find(ctx.textFiles, /(connection_limit|pool_max|maxPoolSize)=(\d+)|\bDB_POOL(?:_MAX|_SIZE)?\s*[=:]\s*['"]?(\d+)/),
  ];
  const nums = sizes.map((h) => Number(h.m[2] || h.m[3])).filter((n) => n > 0);
  const replicas = find([...ctx.k8s, ...ctx.compose], /^\s*replicas\s*:\s*(\d+)/m).map((h) => Number(h.m[1]));
  const maxRep = find(ctx.k8s, /maxReplicas\s*:\s*(\d+)/).map((h) => Number(h.m[1]));
  const surge = find(ctx.k8s, /maxSurge\s*:\s*['"]?(\d+%?)/).map((h) => h.m[1]);
  const pooler = find(ctx.textFiles, /pgbouncer|pgcat|odyssey|rds[-_ ]?proxy|supavisor|pgbouncer=true/i);

  if (!nums.length) b.info('Pool size not set explicitly — driver defaults apply (node-postgres 10, Prisma `num_cpus*2+1`, MongoDB 100). Setting it explicitly makes the math reviewable.');
  else b.info(`Pool size(s) found: ${[...new Set(nums)].join(', ')}.`, ev(sizes));
  const pool = nums.length ? Math.max(...nums) : null;
  const rep = maxRep.length ? Math.max(...maxRep) : (replicas.length ? Math.max(...replicas) : null);
  if (pool && rep) {
    const s = surge[0] || '25%';
    const extra = s.endsWith('%') ? Math.ceil((rep * Number(s.slice(0, -1))) / 100) : Number(s);
    const total = pool * (rep + extra);
    b.manual(`Worst case during a rolling deploy: ${pool} connections × (${rep} replicas + ${extra} surge, rounded up) = **${total}**, plus migration jobs, workers, cron runners and admin tools. Compare with the database's \`max_connections\` minus reserved slots (Postgres \`superuser_reserved_connections\`, default 3; managed services such as RDS reserve more).`);
  } else {
    b.manual('Compute: pool size × max replicas during a deploy (including surge) + workers + migration job + admin tools — it must fit under the database\'s `max_connections`.');
  }
  if (pooler.length) b.info('A connection pooler (PgBouncer/RDS Proxy/…) is referenced.', ev(pooler.slice(0, 2)));
  return b.finish();
}

function check15(ctx) {
  const b = builder(15);
  const req = dedupeLines(find(ctx.src, /Scope\.REQUEST/));
  const inj = find(ctx.src, /@Inject\s*\(\s*(REQUEST|CONTEXT)\s*\)/);
  if (req.length || inj.length) {
    const nFiles = new Set([...req, ...inj].map((h) => h.file.rel)).size;
    b.warn(`Request-scoped provider(s) in ${nFiles} file(s). Request scope propagates up: every provider/controller that injects one is re-instantiated per request. Prefer AsyncLocalStorage / nestjs-cls for per-request data, or durable providers for per-tenant reuse.`, ev([...req, ...inj]));
    b.manual('Trace who injects these providers — the whole chain above them is now per-request.');
  } else {
    b.pass('No request-scoped providers.');
  }
  if (ctx.has('nestjs-cls') || find(ctx.src, /AsyncLocalStorage/).length) b.info('AsyncLocalStorage / nestjs-cls in use for request context.');
  return b.finish();
}

function check16(ctx) {
  const b = builder(16);
  for (const h of find(ctx.src, /@Catch\s*\(\s*\)/)) {
    const t = h.file.text;
    const ext = /extends\s+BaseExceptionFilter/.test(t);
    const logs = /(logger\.|Logger\.|console\.error|captureException|super\.catch)/.test(t);
    if (!ext && !logs) b.warn('Catch-all exception filter that neither extends BaseExceptionFilter nor logs — unexpected errors disappear without a stack trace.', ev([h]));
    else if (!ext) b.warn('Catch-all filter replaces BaseExceptionFilter — make sure HttpExceptions keep their status, everything else becomes an opaque 500, and the stack is logged.', ev([h]));
    else b.pass('Catch-all filter extends BaseExceptionFilter.', ev([h]));
  }
  for (const h of find(ctx.src, /process\.on\s*\(\s*['"](unhandledRejection|uncaughtException)['"]/)) {
    if (!/process\.exit|throw\b/.test(argsOf(h))) b.warn(`\`process.on('${h.m[1]}')\` handler keeps the process alive after an unknown failure. Log it, then exit and let the orchestrator restart.`, ev([h]));
  }
  const maps = find([...ctx.infra, ...ctx.pkgs.map((p) => p.file)], /--enable-source-maps|-r\s+source-map-support\/register|require\(['"]source-map-support/);
  if (maps.length || ctx.prodDeps.has('source-map-support')) b.pass('Source maps enabled for stack traces.', ev(maps.slice(0, 2)));
  else b.warn('Node is not started with `--enable-source-maps` — production stack traces point into compiled `dist/*.js`.');
  const noMaps = find(ctx.textFiles.filter((f) => /^tsconfig.*\.json$/.test(f.base)), /"sourceMap"\s*:\s*false/);
  if (noMaps.length) b.warn('`sourceMap: false` in tsconfig — there are no maps to enable.', ev(noMaps));
  return b.finish('pass');
}

function check17(ctx) {
  const b = builder(17);
  const routes = find(ctx.src, /@(Controller|Get)\s*\(\s*['"`]([^'"`]*(health|healthz|livez?|readyz?|liveness|readiness)[^'"`]*)['"`]/i);
  const terminus = ctx.has('@nestjs/terminus') || find(ctx.src, /HealthCheckService|@HealthCheck\s*\(/).length > 0;
  const paths = routes.map((h) => h.m[2].toLowerCase());
  const live = paths.some((p) => /live/.test(p));
  const ready = paths.some((p) => /ready/.test(p));
  if (live && ready) b.pass('Separate liveness and readiness endpoints.', ev(routes));
  else if (routes.length || terminus) b.warn('Single health endpoint — liveness (is the process alive?) and readiness (can it serve: DB, cache…) should be separate, or a DB blip restarts every pod.', ev(routes));
  else b.warn('No health endpoints. Add liveness (no dependency checks) and readiness (dependency checks) with @nestjs/terminus.');
  for (const h of routes.filter((x) => /live/i.test(x.m[2]))) {
    const body = h.file.window(h.line, 0, 20).split(/\n\s*@Get\s*\(/)[0];
    if (/(pingCheck|HealthIndicator|\.isHealthy|redis|prisma|typeorm|mongoose)/i.test(body)) b.warn('Liveness endpoint checks a dependency — a database outage will make the orchestrator restart healthy processes. Move dependency checks to readiness.', ev([h]));
  }
  const probes = find(ctx.k8s, /(livenessProbe|readinessProbe)\s*:/);
  const probePath = (name) => probes.filter((h) => h.m[1] === name).map((h) => (h.file.window(h.line, 0, 8).match(/path\s*:\s*['"]?([^\s'"]+)/) || [])[1]).filter(Boolean);
  const lp = probePath('livenessProbe'); const rp = probePath('readinessProbe');
  if (lp.length && rp.length && lp.some((p) => rp.includes(p))) b.warn('Kubernetes liveness and readiness probes hit the same path.', ev(probes));

  const jsonLogger = find(ctx.src, /ConsoleLogger\s*\(/).filter((h) => /json\s*:\s*true/.test(argsOf(h)));
  const logLibs = [...ctx.deps.keys()].filter((n) => /^(nestjs-pino|pino|pino-http|winston|nest-winston|bunyan|@ogma\/.+|@nestjs\/observe)$/.test(n));
  if (jsonLogger.length || logLibs.length) b.pass(`Structured logging (${logLibs.join(', ') || 'ConsoleLogger json'}).`, ev(jsonLogger));
  else b.warn('Logs are plain text. Use JSON logs (`new ConsoleLogger({ json: true })`, nestjs-pino…) with production log levels and structured fields.');
  const trace = ctx.hasAny(/^@opentelemetry\//) || ctx.has('nestjs-cls') || find(ctx.src, /traceId|trace_id|x-request-id|correlationId|requestId|genReqId/i).length > 0;
  if (trace) b.pass('Trace/request IDs appear in the codebase.');
  else b.warn('No trace or request ID on log lines — you cannot follow one request across logs.');
  const mon = [...ctx.deps.keys()].filter((n) => /^(@sentry\/.+|@opentelemetry\/.+|dd-trace|newrelic|elastic-apm-node|@nestjs\/observe|@honeybadger-io\/.+|rollbar|@bugsnag\/.+|@datadog\/.+|@appsignal\/.+|@highlight-run\/.+|@axiomhq\/.+)$/.test(n));
  if (mon.length || find(ctx.src, /ObserveModule/).length) b.pass(`Error/performance monitoring (${mon.slice(0, 4).join(', ') || 'ObserveModule'}).`);
  else b.warn('No APM/error monitoring. You want per-route latency and error rates, errors grouped by defect, and an alert when a new one appears.');
  return b.finish();
}

const RUNNERS = { 1: check1, 2: check2, 3: check3, 4: check4, 5: check5, 6: check6, 7: check7, 8: check8, 9: check9, 10: check10, 11: check11, 12: check12, 13: check13, 14: check14, 15: check15, 16: check16, 17: check17 };

// ─────────────────────────── rendering ───────────────────────────

const LABEL = { fail: 'FAIL', warn: 'WARN', manual: 'VERIFY', pass: 'PASS', 'n/a': 'N/A' };
const MARK = { fail: '✗', warn: '!', manual: '?', pass: '✓', info: '·' };

function renderMarkdown(report) {
  const s = report.summary;
  const out = [];
  out.push(`# NestJS preflight — ${report.project.name}`);
  out.push('');
  out.push(`Scanned \`${report.root}\` · ${report.filesScanned} files · @nestjs/core ${report.project.nestVersion || 'not found'} · ${report.scannedAt.slice(0, 10)} · scanner v${report.version}`);
  out.push('');
  out.push(`**${s.fail} fail · ${s.warn} warn · ${s.manual} verify · ${s.pass} pass · ${s['n/a']} n/a**`);
  out.push('');
  if (!report.project.isNest) out.push('> ⚠ `@nestjs/core` was not found in any package.json — results may not be meaningful.\n');
  out.push('| # | Check | Status | Headline |');
  out.push('|---|---|---|---|');
  for (const c of report.checks) {
    const head = (c.findings.find((f) => f.level === c.status) || c.findings[0] || { message: '' }).message.replace(/\|/g, '\\|');
    out.push(`| ${c.id} | ${c.title} | ${LABEL[c.status]} | ${head.length > 110 ? `${head.slice(0, 107)}…` : head} |`);
  }
  out.push('');
  for (const c of report.checks) {
    out.push(`## ${c.id}. ${c.title} — ${LABEL[c.status]}`);
    out.push('');
    for (const f of c.findings) {
      out.push(`- ${MARK[f.level]} ${f.message}`);
      for (const e of f.evidence) out.push(`  - \`${e.file}:${e.line}\`${e.snippet ? ` — \`${e.snippet.replace(/`/g, "'")}\`` : ''}${e.note ? ` (${e.note})` : ''}`);
      if (f.more) out.push(`  - …and ${f.more} more`);
    }
    out.push(`- Reference: \`${c.reference}\``);
    out.push('');
  }
  out.push('---');
  out.push('Heuristic static scan. Every finding needs verification against the code before acting on it; VERIFY items cannot be decided statically. Based on "NestJS Production Checklist: 17 Checks Before You Deploy" (NestJS team).');
  return `${out.join('\n')}\n`;
}

// ───────────────────────────── main ─────────────────────────────

export function scan(rootArg, { only = null, today = null } = {}) {
  const root = path.resolve(rootArg);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const now = today ? new Date(`${today}T00:00:00Z`) : new Date();
  const ctx = buildContext(root, now);
  FILE_INDEX = new Map(ctx.textFiles.map((f) => [f.rel, f]));
  const checks = [];
  for (const [id] of CHECKS) {
    if (only && !only.has(id)) continue;
    try { checks.push(RUNNERS[id](ctx)); } catch (err) {
      const b = builder(id);
      b.manual(`Scanner error in this check: ${err.message}. Verify manually.`);
      checks.push(b.finish());
    }
  }
  const summary = Object.fromEntries(STATUS_ORDER.map((s) => [s, checks.filter((c) => c.status === s).length]));
  return {
    tool: 'nestjs-preflight',
    version: VERSION,
    scannedAt: new Date().toISOString(),
    root,
    filesScanned: ctx.textFiles.length,
    project: {
      name: ctx.rootPkg.name || path.basename(root),
      isNest: ctx.isNest,
      nestVersion: ctx.nestVersion,
      hasDockerfile: ctx.dockerfiles.length > 0,
      hasKubernetes: ctx.k8s.length > 0,
      git: ctx.gitTracked !== null,
    },
    summary,
    checks,
  };
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  let report;
  try { report = scan(opts.root, opts); } catch (err) { die(err.message); }
  const text = opts.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  if (opts.out) {
    fs.writeFileSync(opts.out, text);
    console.error(`scan: wrote ${opts.out} — ${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.manual} verify, ${report.summary.pass} pass`);
  } else {
    process.stdout.write(text);
  }
  const threshold = { fail: ['fail'], warn: ['fail', 'warn'], none: [] }[opts.failOn];
  if (report.checks.some((c) => threshold.includes(c.status))) process.exit(1);
}

export { renderMarkdown, nodeVerdict, stripComments };
