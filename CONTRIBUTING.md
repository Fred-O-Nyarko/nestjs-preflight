# Contributing

Thanks for helping. Here's how to get a change merged quickly. The maintainer is [Frederick Obeng-Nyarko](https://github.com/Fred-O-Nyarko); open an issue or a pull request at <https://github.com/Fred-O-Nyarko/nestjs-preflight>.

## Ground rules

- **No runtime dependencies.** `scan.mjs` must run with plain `node` (≥ 18) on a fresh machine.
- **Never modify the scanned project.** The scanner reads files. It doesn't execute or write to them.
- **When unsure, say VERIFY.** A `manual` finding that asks the right question is better than a confident guess.
- **Evidence or it didn't happen.** Every fail or warn should point at `file:line` where it can.
- **Paraphrase the source article.** Link to it. Don't copy passages from it.

## Fixing a false positive or false negative

1. Reproduce it with the smallest code you can, and add that code to a fixture under `test/fixtures/` (a new fixture folder is fine).
2. Add an assertion in `test/scan.test.mjs`.
3. Fix the heuristic in `skills/nestjs-preflight/scripts/scan.mjs`.
4. Run `npm test`.

## Adding or changing guidance

The detailed guidance for each check lives in `skills/nestjs-preflight/references/`. Every check has the same sections: *Why it matters*, *What good looks like*, *Scanner looks for*, *Verify by hand*, *Fix*. If you recommend an API that only exists in recent Nest releases, add it to `version-notes.md` along with a fallback.

## Keeping the Node.js table current

`NODE_LINES` at the top of `scan.mjs` lists LTS start and end-of-life dates from <https://nodejs.org/en/about/previous-releases>. When Node announces a new line, add it and update the `nodeVerdict` tests.

## Releasing

Bump `version` in `package.json`, `.claude-plugin/plugin.json`, the `metadata.version` in `SKILL.md` and `VERSION` in `scan.mjs`, then update `CHANGELOG.md`. Push a tag such as `v0.1.1`. The `release` workflow runs the tests, creates a GitHub release, and attaches `nestjs-preflight-skill.zip` for Claude app users. Then run `npm publish`.
