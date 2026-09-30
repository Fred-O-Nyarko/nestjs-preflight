# Report template

Use this structure for `nestjs-preflight-report.md`. Keep it scannable: the verdict and the blockers must be visible without scrolling. Evidence is always `path:line`. Don't paste the raw scanner output — the report is the *verified* result.

```markdown
# Preflight check — <app name>

<date> · @nestjs/core <version> · Node <runtime version> · <platform: Kubernetes / ECS / Fly / …>
Context: <replicas / autoscaling max, DB max_connections, proxy hops>

## Verdict: <Ready to deploy | Ready with caveats | Not ready>

<One or two sentences: why, and what has to happen first.>

| Status | Count |
|---|---|
| FAIL — fix before deploying | n |
| WARN — fix soon | n |
| VERIFY — needs someone who knows the setup | n |
| PASS | n |
| N/A | n |

## Assumptions

- <each fact you couldn't read from the repo or get from the user, e.g. "Default RollingUpdate (25% surge) — no manifests in the repo">

## Other blockers

<Problems outside the 17 checks that stop a deploy: dependency conflicts or install failures, build errors, imports of missing files, a start command that can't work. Leave this section out if there are none.>

## Blockers (FAIL)

### <#>. <check title>
**Problem.** <what is wrong, in one or two sentences, and what it will do in production>
**Evidence.** `src/app.module.ts:17` — `synchronize: true`
**Fix.** <concrete change; code snippet if short; version caveat if relevant>

## Should fix (WARN)

<same shape, shorter>

## Needs verification (VERIFY)

- **<#>. <title>** — <the exact question to answer, and who can answer it>

## Passing

<one line per check: "✓ 5. Deny-by-default auth — global JwtAuthGuard via APP_GUARD (src/app.module.ts:24)">

## Not applicable

<one line each, with the reason>

---
Checked against the NestJS team's "NestJS Production Checklist: 17 Checks Before You Deploy". Static analysis plus manual review; runtime behaviour (actual memory limits, probe timing, real traffic) was not observed.
```

## Verdict rules

- **Not ready** — any *Other blocker*, any FAIL in checks 1, 2, 5, 7, 10 (EOL Node or mismatched Nest majors), or 13 (`synchronize: true` / schema push), or three or more FAILs total.
- **Ready with caveats** — other FAILs, or any WARN.
- **Ready to deploy** — only PASS / N/A / VERIFY items that the user has answered.

A finding that rests on an assumption counts at its status. Tag it "(assumed)", and in the verdict sentence say what would change if the assumption is wrong.

These are defaults; the user's risk tolerance wins (an internal tool and a payments API are different). Say which rule drove the verdict.
