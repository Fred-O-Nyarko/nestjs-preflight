# Version notes: recommend what the project can actually use

The NestJS team's checklist uses several APIs and packages that only exist in **recent** Nest releases. Recommending one that doesn't exist in the user's installed version sends them on a wild-goose chase. Before recommending anything in the first table, confirm it's available; if it isn't, recommend the fallback and mention the newer API as the upgrade path.

## How to confirm availability

1. Installed version: `node -p "require('@nestjs/core/package.json').version"` (or read the lockfile).
2. Does the symbol exist in the installed typings? (Only works when `node_modules` is installed. Otherwise, compare the lockfile version with the table below.)
   ```bash
   grep -rl "useSecurityHeaders" node_modules/@nestjs/core node_modules/@nestjs/common --include=*.d.ts
   ```
   The scanner does this automatically for `return503OnClosing` and `useSecurityHeaders` when `node_modules` is present.
3. Does a package exist, and what does it require?
   ```bash
   npm view @nestjs/locks version peerDependencies
   ```
   If the registry isn't reachable, say so and present the recommendation as conditional.

## APIs the checklist describes as recent

Minimum versions below were checked against the published npm typings and peer ranges (September 2026). Nest 12.0.0 was released on 2026-08-27.

| Area | Recent API (per the checklist) | Needs | Fallback that works on older versions |
|---|---|---|---|
| Security headers (6) | `app.useSecurityHeaders()` | `@nestjs/core` ≥ **12.1.0** | `helmet` (Express) / `@fastify/helmet` |
| Standard Schema validation (7) | `StandardSchemaValidationPipe`, `@Body({ schema })` | `@nestjs/common` ≥ **12.0.0** | `ValidationPipe` + class-validator, or a Zod pipe such as `nestjs-zod` |
| Draining (3) | `NestFactory.create(App, { return503OnClosing: true })` | `@nestjs/core` ≥ **12.0.0** | `preStop` delay + readiness failing during shutdown |
| Config (1) | Standard Schema object passed to `validationSchema` | `@nestjs/config` **12.x** (the 4.x line takes Joi) | `validate: (env) => schema.parse(env)` |
| Locks (4) | `@nestjs/locks`: `@OnOneInstance()`, `@WithoutOverlapping()`, `LockStore` | Nest **11 or 12** · package 0.0.x | Postgres advisory locks, `redlock`, BullMQ repeatable jobs, Kubernetes CronJob |
| Auth (5) | `@nestjs/authentication`: `AuthenticationModule` (global guard) | Nest **12** · package 0.0.x | Own guard via `APP_GUARD` + `@Public()` (see `02-the-edge.md`) |
| Idempotency (9) | `@nestjs/idempotency`: `IdempotencyModule`, `@Idempotent()` | Nest **11 or 12** · package 0.0.x · peer deps include `@nestjs/microservices` and `graphql` | Unique request-ID constraint, Redis `SET NX` interceptor |
| HTTP client (11) | `@nestjs/http-client`: `HttpClientModule.register({ name, baseUrl, timeout })` | Nest **11 or 12** · package 0.0.x | `@nestjs/axios` with `timeout`, or `fetch` + `AbortSignal.timeout()` |
| Resilience (12) | `@nestjs/resilience`: `ResilienceModule`, `@Resilience()`, `@Fallback()`, `@Signal()` | Nest **12** · package 0.0.x | `opossum`, `cockatiel` |
| Monitoring (17) | NestJS Observe (`@nestjs/observe`, `ObserveModule`): hosted, free tier | Nest **11 or 12** | OpenTelemetry, Sentry, Datadog, New Relic… |

**Things to know before you recommend the new packages** (checked against the 0.0.1 tarballs):

- **They're ESM-only** (`"type": "module"`, Node ≥ 20.19). A Nest app compiled to CommonJS, which is the default, can only load them through Node's `require(esm)` support: Node 20.19+ or 22.12+. On older Node, or with bundlers that don't support it, they won't load.
- **`@nestjs/locks` and `@nestjs/idempotency` ship only in-memory stores.** For a multi-replica deployment you implement the `LockStore` / idempotency store interface yourself, on Redis or Postgres. The lock contract asks for a lot: atomic acquire, fencing tokens, and compare-and-set renew and release. For a focused fix that's often more work than the fallback, so say so.
- **When the Nest majors are mixed,** for example `@nestjs/common@11` with `@nestjs/core@10`, the peer ranges follow `@nestjs/core`. Fix check 10 first. Until then, treat every package in this table as unavailable.

**The new packages are 0.0.x releases.** When you recommend one, say that it's an early release, suggest pinning an exact version, and offer the fallback as the conservative option. These facts change quickly, so re-check with `npm view <pkg> version peerDependencies` when the registry is reachable. When it isn't, go by this table and say that you did.

## Long-standing APIs (safe on current majors)

`app.enableShutdownHooks()`, lifecycle hooks, `APP_GUARD`/`APP_PIPE`/`APP_FILTER`, `Reflector.getAllAndOverride`, `ValidationPipe` options, `ClassSerializerInterceptor` + `@Exclude()`, `BaseExceptionFilter`, `@nestjs/throttler`, `@nestjs/terminus`, `@nestjs/schedule`, `Scope.REQUEST` / durable providers. `ConsoleLogger({ json: true })` needs Nest 11+.

## Node.js

LTS schedule: <https://nodejs.org/en/about/previous-releases>. The scanner's table (`NODE_LINES` in `scripts/scan.mjs`) is the one date-sensitive piece of data in this skill — if a Node major is missing from it, the scanner reports VERIFY rather than guessing.
