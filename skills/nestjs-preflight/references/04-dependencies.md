# Dependencies (checks 10–15)

---

## 10. Run current versions of Node, Nest and dependencies

**Why it matters.** End-of-life Node lines get no security fixes. Mismatched `@nestjs/*` core packages (e.g. `@nestjs/core@10` with `@nestjs/common@11`) cause subtle DI and decorator bugs. Without a committed lockfile and `npm ci`, CI and production can install different code than you tested. Big-bang upgrades once a year are far riskier than small continuous ones.

**What good looks like.**
- Production runs an **Active or Maintenance LTS** Node line, pinned by major in the base image (`node:24-slim`), `.nvmrc`, and CI. Check the schedule at <https://nodejs.org/en/about/previous-releases>.
- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-*`, `@nestjs/testing`, `@nestjs/microservices`, `@nestjs/websockets` on the **same version**, on the current Nest major.
- Lockfile committed; `npm ci` (or `pnpm install --frozen-lockfile` / `yarn install --immutable`) in CI and Docker.
- Renovate or Dependabot opening small PRs continuously.
- `npm audit --omit=dev` (or an equivalent scanner) in CI.

**Scanner looks for.** Node majors in `FROM node:*`, `.nvmrc`, `.node-version`, `.tool-versions`, CI `node-version`; evaluates them against the release table at the top of `scripts/scan.mjs` (update it when Node publishes a new line). `@nestjs/*` core versions from `node_modules` → lockfile → package.json range. Lockfiles, install commands, audit steps, Renovate/Dependabot config.

**Verify by hand.**
- Is the Nest major the current one? Check `npm view @nestjs/core version` (or the NestJS release notes) rather than assuming.
- `npm audit` findings in dev-only dependencies don't ship — `--omit=dev` is intentional.
- Monorepos: each app's Dockerfile may pin a different Node.
- **Does it install?** Mismatched majors, or a package whose peer range excludes your Nest version (e.g. `@nestjs/swagger@8` with Nest 11), make `npm ci` fail with ERESOLVE. The scanner only compares core packages. To test, run `npm install --package-lock-only --ignore-scripts` on a scratch copy of `package.json`, and check the peer ranges of the other `@nestjs/*` packages too.

**Fix.** Bump the base image / `.nvmrc` / CI to a supported LTS; align `@nestjs/*` with `npm i @nestjs/{common,core,platform-express,testing}@<same version>` (include every core package the project uses); commit the lockfile; switch to `npm ci`; add `renovate.json` (`{ "extends": ["config:recommended"] }`) and an audit step. A major Nest upgrade is a project — flag it and link the migration guide rather than doing it inline.

---

## 11. Time out every outbound call

**Why it matters.** `fetch` has no default timeout, and neither does axios. When a dependency hangs (rather than fails), every request waiting on it holds a socket, memory and often a DB connection — until the process runs out of something and takes every other endpoint down with it. The same applies to database queries: one runaway query pins a pool connection indefinitely.

**What good looks like.**

```ts
await fetch(url, { signal: AbortSignal.timeout(5_000) });

// @nestjs/axios
HttpModule.register({ timeout: 5_000, maxRedirects: 3 });

// The NestJS checklist's @nestjs/http-client (promise-based), one named client per dependency:
HttpClientModule.register({ name: 'payments', baseUrl: 'https://api.payments.example', timeout: '5s' });
// retries: 3 attempts with exponential backoff by default, only for GET/HEAD/OPTIONS/PUT/DELETE

// Postgres (TypeORM / node-postgres): cap query time
TypeOrmModule.forRoot({ /* … */ extra: { statement_timeout: 5_000 } });
// or on the role: ALTER ROLE app SET statement_timeout = '5s';
```

Budget timeouts **including retries**: 3 attempts × 5 s is a 15 s+ request, which may already exceed your upstream/load-balancer timeout.

**Scanner looks for.** `fetch(` without `signal`; `HttpModule.register`, `axios.create`, `HttpClientModule.register` without `timeout`; raw global-axios calls without `axios.defaults.timeout`; DB timeout settings (`statement_timeout`, `query_timeout`, `maxTimeMS`, …) anywhere in the repo.

**Verify by hand.**
- `fetch(url, options)` where `options` is built elsewhere may carry a signal — follow it.
- Third-party SDKs (Stripe, AWS, OpenAI…) have their own timeout options; check the ones that sit on request paths.
- gRPC: deadlines on every call.
- Redis clients: `commandTimeout` / `connectTimeout`.

**Fix.** Add a timeout to every client, preferably centrally (one configured client per dependency) rather than per call site.

---

## 12. Plan for dependencies that are down

**Why it matters.** Timeouts bound how long a single call waits; they don't stop you from hammering a dependency that is already down. Without a circuit breaker, every request still pays the full timeout. Without a bulkhead (concurrency cap), one slow dependency can consume all the event loop's outstanding work. Plain retries make an outage worse.

**What good looks like.** The NestJS checklist describes `@nestjs/resilience`: presets combining timeout, retry, circuit breaker and bulkhead, applied by decorator; when the breaker is open, calls fail fast (503 with `Retry-After`); `@Fallback()` supplies a degraded answer; the injected `signal` must be passed to the actual I/O so timed-out work is really cancelled.

```ts
ResilienceModule.forRoot({
  presets: {
    carrier: {
      timeout: '2s',
      retry: { attempts: 2 },
      circuitBreaker: { failureRateThreshold: 50, minimumCalls: 10, openDuration: '30s' },
    },
  },
});

@Resilience('carrier')
@Fallback('cachedRates')
async rates(order: Order, @Signal() signal: AbortSignal) {
  return this.http.get(`/rates/${order.id}`, { signal }); // pass the signal through
}
```

Only retry non-idempotent methods (POST) when the endpoint is idempotent (see check 9).

**Fallback without the package.** `opossum` or `cockatiel` (circuit breaker + bulkhead + retry + timeout policies) wrapped in a provider.

**Scanner looks for.** Resilience libraries/decorators; retry-only libraries; outbound HTTP/SDK usage without any breaker.

**Verify by hand.** For each critical dependency: what happens to *our* endpoint when it's down? Is there a sensible fallback (cached data, degraded response, queue for later)? Are retries limited to idempotent operations?

**Fix.** Wrap the critical dependencies (payments, auth provider, core internal services) first; don't boil the ocean.

---

## 13. Run migrations as a deploy step

**Why it matters.** `synchronize: true` / `prisma db push` / `drizzle-kit push` diff the model against the database and apply whatever it takes — including dropping columns with data — with no review and no history. Running migrations inside app startup means every replica races to run them on every restart, and a slow migration fails health checks and crash-loops the rollout.

**What good looks like.**
- Reviewed, committed migration files (TypeORM migrations, `drizzle-kit generate` + `migrate`, `prisma migrate dev` → `prisma migrate deploy`).
- Applied **once per deploy** by a separate step *before* the new version rolls out: a Kubernetes Job / Helm `pre-upgrade` hook, a platform release phase (Heroku `release:`, Fly `release_command`, Render pre-deploy command), or a CI job.
- **Backward compatible** with the version still running: expand → deploy → contract. Renaming or dropping a column is two deploys (add new + dual-write → switch reads → drop old).
- Rollback = redeploy the previous image, so the previous version must tolerate the new schema. Don't count on down-migrations in an incident.

**Scanner looks for.** `synchronize: true` (FAIL) or computed; `sequelize.sync({ alter|force })`; `migrationsRun: true`; `db push` in deploy paths; migrate commands in `CMD`/start scripts/entrypoint scripts/initContainers; Jobs, Helm hooks, release phases and CI steps that run migrations.

**Verify by hand.**
- `synchronize: config.get('DB_SYNC')` — read the production value.
- Open the latest migrations: any `DROP COLUMN`, `RENAME`, `NOT NULL` without default, or long table rewrites / non-concurrent index builds on big tables?
- Who runs migrations in practice? Ask if nothing is found — "a developer from a laptop" is a finding.

**Fix.** Turn `synchronize` off, generate a baseline migration, and add a pre-deploy migration step. Point out any non-backward-compatible migration in the pending set.

---

## 14. Check the connection pool math

**Why it matters.** Every replica opens its own pool. During a rolling deploy old and new pods coexist, autoscaling adds more, and migration jobs, queue workers, cron runners and admin tools connect too. Exceed the database's `max_connections` and new connections fail — usually in the middle of the deploy.

**The math.**

```
pool size × (max replicas + surge during deploy)
  + workers × their pool
  + migration job
  + admin/BI tools
  ≤ max_connections − reserved (superuser/replication) slots
```

Driver defaults: node-postgres `max: 10`, Prisma `connection_limit = num_cpus × 2 + 1`, MongoDB `maxPoolSize: 100`. When the numbers grow, put a pooler in front (PgBouncer, RDS Proxy, Supavisor) — in transaction mode, check the ORM's prepared-statement compatibility.

**Scanner looks for.** Explicit pool sizes; `replicas`, HPA `maxReplicas`, `maxSurge`; pooler references. It computes the worst case when it has both numbers.

**Verify by hand.**
- Ask for the database's `max_connections` (`SHOW max_connections;`) and the real autoscaling max.
- Subtract reserved slots. Postgres keeps `superuser_reserved_connections` (default 3) free, and managed services such as RDS reserve a few more for their own admin users.
- The rolling-update surge rounds **up**: 25% of 3 replicas is 1 extra pod, not 0.75.
- Count the other processes that share the database.
- If there's comfortable headroom (say, below 70% of the usable connections), PASS with the numbers shown.

**Fix.** Set the pool size explicitly, cap autoscaling, or add a pooler.

---

## 15. Watch for request-scoped chains

**Why it matters.** `Scope.REQUEST` *propagates up*: every provider and controller that injects a request-scoped provider becomes request-scoped too, and the whole chain is re-instantiated on every request. One innocent `@Inject(REQUEST)` in a logger can turn half the dependency graph per-request — more latency, more GC, and singletons (connections, caches) that silently stop being singletons.

**What good looks like.** Per-request data (current user, tenant, trace ID) via `AsyncLocalStorage`, usually through `nestjs-cls`:

```ts
imports: [ClsModule.forRoot({ global: true, middleware: { mount: true } })]
// anywhere, singleton-scoped:
constructor(private cls: ClsService) {}
const userId = this.cls.get('userId');
```

For per-tenant instances, *durable providers* (`durable: true` + a `ContextIdStrategy`) reuse one sub-tree per tenant instead of per request.

**Scanner looks for.** `Scope.REQUEST`, `@Inject(REQUEST)` / `@Inject(CONTEXT)`.

**Verify by hand.** For each hit, find who injects it (search for the class name in constructors) and walk up the chain to the controllers. Report the chain length.

**Fix.** Replace request injection with `ClsService`/`AsyncLocalStorage`, or isolate the request-scoped provider so nothing long-lived depends on it.
