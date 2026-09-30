# nestjs-preflight

[![ci](https://github.com/Fred-O-Nyarko/nestjs-preflight/actions/workflows/ci.yml/badge.svg)](https://github.com/Fred-O-Nyarko/nestjs-preflight/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**An open-source agent skill that runs the NestJS team's production checklist against your NestJS app before you deploy.**

The NestJS team published [*NestJS Production Checklist: 17 Checks Before You Deploy*](https://dev.to/nestjs/nestjs-production-checklist-17-checks-before-you-deploy-1d0j). This repo turns that checklist into something an AI coding agent can run for you. The agent scans your codebase and deploy config, checks each finding against the actual code, writes a pass/warn/fail report with `file:line` evidence, and offers to fix the problems one at a time.

Think of it as a pilot's preflight checklist for your API. (This has nothing to do with CORS preflight requests.)

It also ships a **zero-dependency scanner** that you can run by itself or in CI.

> Community project. Not affiliated with or endorsed by the NestJS team. All credit for the checklist goes to them, so please read the original article.

---

## What it checks

| Section | # | Check |
|---|---|---|
| Startup and deploys | 1 | Validate config at boot; keep secrets out of the image |
| | 2 | Handle SIGTERM and get the container right |
| | 3 | Drain traffic before you close |
| | 4 | Scheduled jobs run on every replica |
| The edge | 5 | Authentication is deny-by-default |
| | 6 | Security headers, CORS, rate limits, trust proxy |
| Input and output | 7 | Validate every input |
| | 8 | Control what goes out |
| | 9 | Make writes safe to repeat |
| Dependencies | 10 | Run current Node, Nest and dependencies |
| | 11 | Time out every outbound call |
| | 12 | Plan for dependencies that are down |
| | 13 | Run migrations as a deploy step |
| | 14 | Check the connection pool math |
| | 15 | Watch for request-scoped chains |
| Errors and visibility | 16 | Errors: statuses, logs, source maps |
| | 17 | Logs, health checks, monitoring |

The scanner reads TypeScript and JavaScript source, `package.json` and lockfiles, Dockerfiles, Kubernetes manifests and Helm charts, docker-compose files, platform config (Procfile, `fly.toml`, `render.yaml`…) and CI workflows.

## Install the skill

The skill lives in [`skills/nestjs-preflight/`](skills/nestjs-preflight/) and uses the standard `SKILL.md` format.

**Claude Code** (plugin marketplace):

```
/plugin marketplace add Fred-O-Nyarko/nestjs-preflight
/plugin install nestjs-preflight@nestjs-preflight
```

Or copy the folder in by hand:

```bash
git clone https://github.com/Fred-O-Nyarko/nestjs-preflight
cp -r nestjs-preflight/skills/nestjs-preflight ~/.claude/skills/        # for all projects
# or: cp -r … <your-project>/.claude/skills/                                          # for one repo
```

**Claude apps (claude.ai, desktop, Cowork):** zip the `skills/nestjs-preflight` folder and upload it under *Settings → Capabilities → Skills*.

**Other agents that support Agent Skills:** copy `skills/nestjs-preflight` into your agent's skills directory. The scanner needs nothing except Node ≥ 18.

## Use it

Ask your agent in plain language:

- "Is this Nest API ready for production?"
- "We're deploying to k8s with 3 replicas next week. Run the pre-deploy checks."
- "Our cron job fires three times an hour. Why?"

The agent runs the scanner, asks at most one batched question about things the code can't tell it (replica count, `max_connections`, proxy hops), reviews every finding, and writes `nestjs-preflight-report.md` with a verdict:

```
## Verdict: Not ready

7 FAIL · 8 WARN · 2 VERIFY · 0 PASS

### 13. Run migrations as a deploy step — FAIL
Problem. `synchronize: true` makes TypeORM rewrite the schema on every boot. It can drop columns
and it races across replicas.
Evidence. `src/app.module.ts:17` — `synchronize: true,`
Fix. Set it to false, generate a baseline migration, and run `typeorm migration:run` from a
pre-deploy Job or Helm pre-upgrade hook.
```

It then offers to fix the FAIL items first. It asks before it adds dependencies, touches infrastructure, or makes any change clients would notice.

## Run the scanner by itself

```bash
# from a clone
node skills/nestjs-preflight/scripts/scan.mjs path/to/your-nest-app

# or without cloning
npx github:Fred-O-Nyarko/nestjs-preflight path/to/your-nest-app
```

| Option | |
|---|---|
| `--format md\|json` | Markdown (default) or JSON |
| `--out FILE` | Write the report to a file |
| `--only 1,4,13` | Run only these checks |
| `--fail-on fail\|warn\|none` | Exit 1 at or above this level (default `none`) |
| `--ci` | Same as `--fail-on fail` |
| `--today YYYY-MM-DD` | Date used for Node.js EOL checks (for reproducible runs) |

Statuses: **FAIL** (known way production breaks), **WARN** (real risk), **VERIFY** (can't be decided statically), **PASS**, **N/A**.

Evidence snippets never include secret values; they're redacted.

**Suppressing a finding.** Add `// preflight-ignore: 4 our leader election guards this` (or `# preflight-ignore: 2` in YAML or a Dockerfile) on the flagged line or the line above it. The finding then appears as a suppressed note. Leave out the check numbers to suppress every check on that line.

### In CI

```yaml
- uses: actions/checkout@v4
- run: npx github:Fred-O-Nyarko/nestjs-preflight . --ci --out preflight.md
```

The scanner is heuristic, so gate on FAIL only and read the WARN items.

## How it works

- **The scanner collects leads; the agent decides.** `scan.mjs` pattern-matches source, with comments stripped, and infrastructure files. It never executes or modifies your project. Anything it can't decide is reported as VERIFY, not guessed.
- **Version-aware.** Several APIs in the checklist (`useSecurityHeaders()`, `StandardSchemaValidationPipe`, `return503OnClosing`, `@nestjs/locks`, `@nestjs/idempotency`, `@nestjs/resilience`, …) only exist in recent Nest releases. When `node_modules` is present, the scanner feature-detects them in the installed typings. The skill tells the agent to confirm availability first and offer a fallback that works on older versions (see [`references/version-notes.md`](skills/nestjs-preflight/references/version-notes.md)).
- **Progressive disclosure.** `SKILL.md` holds the workflow and a quick-reference table. The detailed guidance for each check lives in `references/` and is loaded only when the agent needs it.

```
skills/nestjs-preflight/
├── SKILL.md                         # workflow + quick reference
├── scripts/scan.mjs                 # zero-dependency scanner (Node ≥ 18)
└── references/
    ├── 01-startup-and-deploys.md    # checks 1–4
    ├── 02-the-edge.md               # checks 5–6
    ├── 03-input-and-output.md       # checks 7–9
    ├── 04-dependencies.md           # checks 10–15
    ├── 05-errors-and-visibility.md  # checks 16–17
    ├── version-notes.md             # recent APIs and their fallbacks
    └── report-template.md           # report structure + verdict rules
```

## Limitations

- Static analysis only. It doesn't observe real memory limits, probe timing, traffic or database load.
- Heuristics produce false positives and misses. That's why the skill has the agent verify each finding. Please report them; see below.
- The Node.js release table in `scan.mjs` is date-sensitive and needs updating when Node ships a new line.

## Contributing

Pull requests are welcome, especially false-positive and false-negative fixes that come with a test fixture. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test   # node:test, no dependencies
```

## Author

**Frederick Obeng-Nyarko**

- GitHub: [@Fred-O-Nyarko](https://github.com/Fred-O-Nyarko)
- LinkedIn: [frederick-o-12081aa2](https://www.linkedin.com/in/frederick-o-12081aa2/)
- X: [@fred_o_nyarko](https://x.com/fred_o_nyarko)
- Email: [nernuer@gmail.com](mailto:nernuer@gmail.com)

Built for the love of open source. If it saves you a bad deploy, a star on the repo is appreciated.

## License

[MIT](LICENSE). The checklist content belongs to its authors at NestJS. This repo paraphrases it and links to the original.
