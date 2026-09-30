# Changelog

## 0.1.0 — 2026-09-30

- First release: the skill (`SKILL.md` plus per-section references) and a zero-dependency scanner covering all 17 checks in the NestJS Production Checklist.
- Markdown and JSON output, `--only`, `--ci` / `--fail-on`.
- Feature detection for recent Nest APIs in the installed typings.
- Good and bad fixture apps with a `node:test` suite.
- `preflight-ignore` comments, secret redaction in evidence, and lockfile/Node-pin lookup at the monorepo root.
- Verified minimum versions for the recent APIs the checklist uses (Nest 12.0 / 12.1) and caveats for the 0.0.x `@nestjs/*` packages.
