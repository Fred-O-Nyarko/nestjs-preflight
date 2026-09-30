---
name: nestjs-preflight
description: Run the NestJS team's 17-point production checklist against a NestJS codebase before it ships — config validation, SIGTERM and graceful shutdown, Docker, cron jobs on replicas, deny-by-default auth, headers/CORS/rate limits, input validation, response serialization, idempotency, Node/Nest versions, timeouts, circuit breakers, migrations, pool math, request scope, error handling, health checks, logging and monitoring. Produces an evidence-backed pass/warn/fail report and offers fixes. Use whenever someone asks whether a NestJS app or API is production-ready, wants a preflight, pre-deploy, launch-readiness, reliability or security review of a Nest service, is about to deploy or scale a NestJS app, or asks what to check before going live — even if they never say "checklist".
license: MIT
metadata:
  author: Frederick Obeng-Nyarko
  version: 0.1.0
  repository: https://github.com/Fred-O-Nyarko/nestjs-preflight
---

# NestJS preflight

Audit a NestJS codebase against the 17 checks in the NestJS team's *NestJS Production Checklist: 17 Checks Before You Deploy* ([dev.to/nestjs](https://dev.to/nestjs/nestjs-production-checklist-17-checks-before-you-deploy-1d0j)), then offer to fix what's wrong.

Every check targets a failure that doesn't show up locally, where you have one process, no load balancer, no concurrent deploys and a database to yourself, but does show up in production. The report should read like it came from a senior engineer who has seen those failures happen: specific, backed by evidence, no invented alarms.

## How this skill is organised

- `scripts/scan.mjs`: zero-dependency Node scanner (Node ≥ 18). It turns up leads with `file:line` evidence and never modifies the project.
- `references/01-…05-*.md`: one file per checklist section. For each check: why it matters, what good looks like, what the scanner looks for, what to check by hand, and how to fix it. Read the section for a check before you rule on it or change code for it.
- `references/version-notes.md`: which recommended APIs only exist in recent Nest releases, and the fallback for each.
- `references/report-template.md`: report structure and verdict rules.

If the `scripts/` or `references/` folders are missing (for example, only this file was installed), the workflow still works: skip the scanner, inspect the code yourself using the quick reference at the end of this file, and state in the report that no automated scan ran.

## Focused requests

Not every request is a full audit. "Why does our cron fire three times?" or "is our CORS config OK?" should get a focused answer:

1. Match the request to the relevant check(s) and read their reference sections.
2. Run `scan.mjs --only <ids>` for those checks. Also run check 10, and the install check from step 4, when your fix depends on the Nest version.
3. Explain the cause, then fix it with the smallest change (see step 6).
4. Don't write the full report. If you spotted serious problems along the way, list them in a few lines under "noticed, not touched" and offer a full preflight check.

## Workflow

### 1. Find the app

Confirm that it's a NestJS project: `@nestjs/core` appears in a `package.json`. In a monorepo (`nest-cli.json` with `projects`, or `apps/*`), ask which app is being deployed, or check each one. Infrastructure files (Dockerfile, `k8s/`, Helm charts, CI) often live at the repo root, so scan from the directory that contains both the app and its deploy config.

### 2. Run the scanner

```bash
node <skill-dir>/scripts/scan.mjs <project-root> --out <scratch>/preflight.md
```

Use `--format json` only if you want to process the results with a script. `--only 4,13` re-runs specific checks after a fix. `--ci` exits 1 if any check fails. Evidence snippets have secret values redacted.

If the project doesn't have `node_modules` installed, the scanner falls back to the lockfile, and then to the version ranges declared in `package.json`. The header shows which one it used. A declared range isn't the version that will actually be installed, so take that into account.

Treat the output as a list of leads to follow up, not as the verdict. It pattern-matches, so it produces false positives (a `fetch` whose options object carries a signal it can't see) and false negatives (a custom auth guard with an unusual name). Its statuses are `fail`, `warn`, `manual` (shown as VERIFY: can't be decided statically), `pass` and `n/a`.

### 3. Collect the deploy context the code can't tell you

Several checks depend on facts that live outside the repo. Read what you can first: manifests, Helm values, platform config files, CI. Then ask in **one** batched question only for what's still missing and actually changes a verdict:

- Where does it run? (Kubernetes, ECS, Cloud Run, Fly, Render, a VM…)
- Maximum replica count, including autoscaling and deploy surge
- The database's `max_connections`, plus other processes that share it (workers, cron runners, BI tools)
- Is it behind a load balancer or CDN? How many proxy hops?
- Public API or internal-only service (for example, behind an authenticating gateway)?

If nobody is there to answer, pick a conservative assumption, label it in the report ("Assumed: 2 proxy hops"), and carry on.

### 4. Confirm it installs and builds, then verify every check

First, a sanity check that none of the 17 checks covers but that decides the verdict: **does the project install and build?** If `node_modules` is missing, copy `package.json` (and the lockfile, if there is one) into a scratch directory and run `npm install --package-lock-only --ignore-scripts` there. That catches peer-dependency conflicts, for example mismatched `@nestjs/*` majors. If dependencies are installed, run the build (`npm run build`). Also look for imports of files that don't exist and a production start command that can't work (for example, `prisma migrate deploy` in an app that doesn't use Prisma). Report these as **Other blockers**. Don't modify the user's lockfile or `node_modules` for this check.

Then go through all 17 checks. For each one:

1. Open every evidence location the scanner reported and read the surrounding code. Is the finding real?
2. Read that check's "Verify by hand" list in its reference file and do the items that apply. That's where the scanner's blind spots are listed.
3. Assign the final status with evidence. Downgrade false positives and say why ("fetch in `avatar.service.ts:12` gets its signal from `this.opts`, which sets `AbortSignal.timeout`"). Resolve every VERIFY into pass, warn or fail where the code or the user's answers allow it.
4. Before you recommend an API from the checklist, confirm the project's Nest version has it. `references/version-notes.md` gives the minimum version for each one:
   - Nest 12.0 or later: `return503OnClosing` and `StandardSchemaValidationPipe`.
   - Nest 12.1 or later: `app.useSecurityHeaders()`.
   - Nest 12 only: `@nestjs/resilience` and `@nestjs/authentication`.
   - Nest 11 or 12: `@nestjs/locks`, `@nestjs/idempotency` and `@nestjs/http-client`.

   The new packages are early releases (0.0.x), so say so. When an API isn't available, lead with the fallback and mention the newer API as the upgrade path.

Severity is about production consequences, not style:

- **FAIL**: a known way for production to break or leak. Fix before deploying. Examples: `synchronize: true`, shell-form `CMD`, cron jobs with no lock on a multi-replica deployment, opt-in auth, no global validation, end-of-life Node.
- **WARN**: real risk that won't break the next deploy. Fix soon.
- **VERIFY**: can't be decided without someone who knows the setup. Phrase it as the exact question to answer.
- **PASS** / **N/A**: include the evidence or the reason in one line.

### 5. Write the report

Follow `references/report-template.md`. Write it to `nestjs-preflight-report.md` in the project root, unless the user wants it somewhere else or only in chat. If the user asked you not to change anything yet, write the report to a scratch location or put it in the chat, and offer to save it to the repo. In chat, give the verdict, the blocker count, and the top three fixes in a few lines. Leave the details to the report.

Keep evidence concrete (`src/app.module.ts:17`) and keep fixes minimal: what to change, and a short snippet. Don't paste the scanner's raw output as the report.

If you find a committed secret (a `.env` in git, credentials in a Dockerfile `ENV`), say plainly that the secret must be **rotated**. Deleting the file doesn't remove it from git history or from images already pushed. Never print the secret's value in the report.

### 6. Offer fixes

After the report, offer to fix the FAIL items first, then the WARN items. When the user accepts:

- Work one check at a time. Explain the change, make the smallest diff that resolves it, and follow the patterns already in the codebase (its config style, its module layout).
- Ask before adding a dependency, changing infrastructure (Dockerfile, manifests, CI), or changing behaviour clients will notice (turning on `forbidNonWhitelisted`, globalising an auth guard, restricting CORS). These can break existing clients, so say what might break.
- For global auth: add `@Public()` to the routes that were intentionally public (health checks, login, webhooks) *before* switching the guard on. Otherwise the change takes down the health checks.
- Never edit secret values, rotate credentials, or run migrations against a real database yourself.
- After changes, run the project's build, lint and tests if they exist, then run `scan.mjs --only <ids>` on the checks you touched and update the report.
- If the project doesn't install or build as committed, don't fix that silently as part of an unrelated change. Test your change in a scratch copy that has the minimum needed to install, and say exactly what you changed there. Report the install problem as its own blocker.
- If the scanner still flags a correct fix because it doesn't recognise your pattern (a custom lock helper, say), add a `// preflight-ignore: <id> <reason>` comment on or above the flagged line, and mention it.

Some fixes are projects, not patches: a major Nest upgrade, moving migrations into a pipeline, adding monitoring. Scope those as follow-ups with the next concrete step instead of attempting them inline.

## Using it in CI

The scanner can run in CI as a guardrail. It's heuristic, so fail the build only on FAIL:

```yaml
- run: node path/to/nestjs-preflight/scripts/scan.mjs . --ci --out preflight.md
```

## Quick reference: the 17 checks

Use this if the reference files are unavailable. Otherwise, the reference files have the details.

| # | Check | Good looks like |
|---|---|---|
| 1 | Validate config at boot; secrets out of the image | Schema via `ConfigModule.forRoot({ validationSchema })` or `validate`; `getOrThrow()`; secrets from the platform store; `.env*` gitignored and dockerignored; config never logged |
| 2 | Handle SIGTERM; container right | `app.enableShutdownHooks()`; exec-form `CMD ["node","dist/main.js"]`; init process or `useProcessExit: true`; multi-stage build; `USER node`; `NODE_ENV=production`; `--max-old-space-size` ≈ 75% of the memory limit |
| 3 | Drain before you close | `preStop` sleep (~5s); `terminationGracePeriodSeconds` covers preStop plus the longest job; `return503OnClosing` on recent Nest; idempotent jobs |
| 4 | Scheduled jobs run on every replica | `@OnOneInstance()` / `@WithoutOverlapping()` (@nestjs/locks) with a Redis/Postgres store, or a distributed lock; jobs process current state |
| 5 | Deny-by-default auth | Global guard via `APP_GUARD`; `@Public()` opt-outs; the list of public routes is the unauthenticated surface to review |
| 6 | Headers, CORS, rate limits, proxy | `useSecurityHeaders()` or helmet; explicit CORS origins; ThrottlerModule + guard on login, reset and other expensive routes; `trust proxy` = real hop count |
| 7 | Validate every input | Global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` or `StandardSchemaValidationPipe`; bounded `limit`s with defaults; keep the 100 KB body limit |
| 8 | Control what goes out | Response DTOs or `@Exclude()` + `ClassSerializerInterceptor`; Swagger off in production or behind auth |
| 9 | Writes safe to repeat | `Idempotency-Key` support with a shared store; `@Idempotent({ required: true })` on payment-like POSTs |
| 10 | Current Node, Nest, deps | Active or Maintenance LTS Node; aligned `@nestjs/*` versions; committed lockfile + `npm ci`; Renovate/Dependabot; `npm audit --omit=dev` in CI |
| 11 | Time out outbound calls | `AbortSignal.timeout()` on fetch; client-level `timeout`; DB `statement_timeout`; budget timeouts × retries |
| 12 | Dependencies that are down | Circuit breaker, bulkhead, fallback (@nestjs/resilience, opossum, cockatiel); pass the abort signal through to the I/O |
| 13 | Migrations as a deploy step | No `synchronize: true` / `db push`; reviewed migrations run once by a pre-deploy job; backward compatible (expand/contract); rollback = previous image |
| 14 | Pool math | pool × (max replicas + surge) + workers + jobs + tools ≤ `max_connections`; PgBouncer when it grows |
| 15 | Request-scoped chains | Avoid `Scope.REQUEST` / `@Inject(REQUEST)` spreading up the graph; use `nestjs-cls` / AsyncLocalStorage or durable providers |
| 16 | Errors, logs, source maps | Keep default exception semantics (extend `BaseExceptionFilter`); let unhandled rejections crash after logging; `--enable-source-maps` |
| 17 | Logs, health, monitoring | JSON logs, production levels, trace IDs; liveness without dependency checks, readiness with them; per-route latency, error rates, grouped errors, alerts on new ones |
