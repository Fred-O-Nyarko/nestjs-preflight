import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { scan, nodeVerdict, stripComments, renderMarkdown } from '../skills/nestjs-preflight/scripts/scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);
const TODAY = '2026-09-30';
const statuses = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));

test('bad-app: every seeded problem is caught', () => {
  const s = statuses(scan(fixture('bad-app'), { today: TODAY }));
  const expected = {
    1: 'fail', 2: 'fail', 3: 'manual', 4: 'fail', 5: 'fail', 6: 'warn', 7: 'fail', 8: 'warn', 9: 'warn',
    10: 'fail', 11: 'warn', 12: 'warn', 13: 'fail', 14: 'manual', 15: 'warn', 16: 'warn', 17: 'warn',
  };
  for (const [id, status] of Object.entries(expected)) assert.equal(s[id], status, `check ${id}`);
});

test('good-app: no fails, and nothing flagged that is actually fine', () => {
  const report = scan(fixture('good-app'), { today: TODAY });
  const s = statuses(report);
  assert.equal(report.summary.fail, 0, JSON.stringify(s));
  assert.equal(report.summary.warn, 0, JSON.stringify(report.checks.filter((c) => c.status === 'warn'), null, 2));
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 16, 17]) assert.equal(s[id], 'pass', `check ${id}`);
  // Pool math is inherently manual, but the numbers should be computed: 10 × (6 + 1)
  const c14 = report.checks.find((c) => c.id === 14);
  assert.match(c14.findings.map((f) => f.message).join('\n'), /\*\*70\*\*/);
});

test('bad-app: specific findings', () => {
  const report = scan(fixture('bad-app'), { today: TODAY });
  const msgs = (id) => report.checks.find((c) => c.id === id).findings.map((f) => `${f.level} ${f.message}`).join('\n');
  assert.match(msgs(1), /^fail .*COPY \. .*\.env/m, '.env + COPY . . without .dockerignore is a FAIL');
  assert.match(msgs(5), /^fail .*no auth guard at all/m, 'lists unguarded routes');
  assert.match(msgs(6), /^warn `cors: true` sends `Access-Control-Allow-Origin: \*`/m);
  assert.match(msgs(7), /^warn .*@Body\(\)` typed as any/m);
  const json = JSON.stringify(report);
  assert.ok(!json.includes('hunter2') && !json.includes('changeme'), 'secret values are redacted');
  const script = report.checks.find((c) => c.id === 13).findings.flatMap((f) => f.evidence).find((e) => e.snippet.includes('start:prod'));
  assert.equal(script.line, 6, 'package.json script evidence has the real line');
  assert.match(report.project.nestVersion, /declared, not installed/);
});

test('cors origin: true is a FAIL (reflects any origin)', () => {
  // inline mini-project
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndp-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '12.1.2' } }));
  fs.writeFileSync(path.join(dir, 'src/main.ts'), "const app = await NestFactory.create(AppModule);\napp.enableCors({ origin: true, credentials: true });\n");
  const c6 = scan(dir, { only: new Set([6]), today: TODAY }).checks[0];
  assert.equal(c6.status, 'fail');
  assert.match(c6.findings.map((f) => f.message).join('\n'), /Your Nest version has `app.useSecurityHeaders\(\)`/, 'feature detection from declared version');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preflight-ignore suppresses a finding; SET NX counts as a lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndp-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '11.1.6', '@nestjs/schedule': '5.0.0' } }));
  fs.writeFileSync(path.join(dir, 'src/a.job.ts'), [
    'export class A {',
    "  @Cron('0 * * * *')",
    '  async run() {',
    "    if ((await this.redis.set(key, id, 'PX', 7_200_000, 'NX')) !== 'OK') return;",
    '  }',
    '  // preflight-ignore: 4 guarded by our own leader election',
    "  @Interval(1000)",
    '  async tick() { await this.leader.runIfLeader(); }',
    '}',
  ].join('\n'));
  const c4 = scan(dir, { only: new Set([4]), today: TODAY }).checks[0];
  assert.equal(c4.status, 'pass', JSON.stringify(c4.findings, null, 2));
  assert.ok(c4.findings.some((f) => /^Suppressed by preflight-ignore/.test(f.message)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--only limits the checks', () => {
  const report = scan(fixture('good-app'), { only: new Set([4, 13]), today: TODAY });
  assert.deepEqual(report.checks.map((c) => c.id), [4, 13]);
});

test('evidence points at file:line', () => {
  const report = scan(fixture('bad-app'), { today: TODAY });
  const sync = report.checks.find((c) => c.id === 13).findings.find((f) => /synchronize: true/.test(f.message));
  assert.equal(sync.evidence[0].file, 'src/app.module.ts');
  assert.equal(sync.evidence[0].line, 17);
});

test('nodeVerdict follows the release schedule', () => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  assert.equal(nodeVerdict(20, d).level, 'fail');
  assert.equal(nodeVerdict(22, d).level, 'pass');
  assert.equal(nodeVerdict(24, d).level, 'pass');
  assert.equal(nodeVerdict(25, d).level, 'warn');
  assert.equal(nodeVerdict(26, d).level, 'warn'); // Current until LTS in late Oct 2026
  assert.equal(nodeVerdict(26, new Date('2026-12-01T00:00:00Z')).level, 'pass');
  assert.equal(nodeVerdict(22, new Date('2027-02-01T00:00:00Z')).level, 'warn'); // EOL soon
});

test('stripComments keeps strings and line numbers', () => {
  const src = "const a = 'http://x'; // note\n/* block\n comment */ const b = \"//\";";
  const out = stripComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.match(out, /'http:\/\/x'/);
  assert.match(out, /"\/\/"/);
  assert.doesNotMatch(out, /note|block/);
});

test('commented-out code is ignored', () => {
  // good-app has no commented-out synchronize: true; bad signals must come from live code only
  const report = scan(fixture('good-app'), { today: TODAY });
  assert.ok(!JSON.stringify(report).includes('synchronize: true'));
});

test('markdown renders every check', () => {
  const md = renderMarkdown(scan(fixture('bad-app'), { today: TODAY }));
  for (let i = 1; i <= 17; i++) assert.match(md, new RegExp(`## ${i}\\. `));
});
