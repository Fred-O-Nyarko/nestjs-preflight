# Startup and deploys (checks 1–4)

Each check below has the same shape: **why it matters**, **what good looks like**, **what the scanner looks for**, **what to verify by hand**, and **how to fix it**. Code marked *recent Nest* uses APIs the NestJS team's checklist describes that only exist in recent releases — confirm they exist in the project's installed version before recommending them (see `version-notes.md`).

---

## 1. Validate config at boot; keep secrets out of the image

**Why it matters.** Without validation, a missing or malformed environment variable is discovered the first time some code path reads it — in production, under traffic, maybe hours after the deploy looked healthy. Validating at boot turns that into a crash-looping pod that never takes traffic, which a rollout will catch and halt. Secrets in `.env` files, image layers or logs are readable by anyone who can pull the image or read the log store.

**What good looks like.**

```ts
// env.ts
import { z } from 'zod';
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().default(3000),
});

// app.module.ts — Standard Schema (Zod/Valibot/ArkType) via validationSchema on recent @nestjs/config
ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema });

// Works on any @nestjs/config version:
ConfigModule.forRoot({ isGlobal: true, validate: (env) => envSchema.parse(env) });

// Reading values
const url = config.getOrThrow<string>('DATABASE_URL'); // not config.get()
```

- Secrets come from the platform's secret store (Kubernetes Secrets / External Secrets, AWS Secrets Manager, Doppler, Fly secrets…), injected as env vars at runtime.
- `.env*` is in both `.gitignore` and `.dockerignore`.
- Nobody logs the config object or `process.env`.

**Scanner looks for.** `ConfigModule.forRoot` without `validationSchema`/`validate`; direct `process.env` use with no schema parse; `config.get(` calls; `.env` files tracked by git (or not gitignored); Dockerfile `COPY .env`, `COPY . .` without a `.dockerignore` entry, `ENV`/`ARG` with secret-looking names; logging of `config`/`process.env`.

**Verify by hand.**
- Does the schema cover *every* variable the app reads? Grep `getOrThrow(`/`get(` keys and compare with the schema.
- `config.get('X', default)` with a sensible default is fine — downgrade those.
- A `.env` file used only by docker-compose for local dev is fine if it is gitignored and dockerignored.
- CI logs: does a workflow `echo` secrets or print `env`?

**Fix.** Add the schema + `validationSchema`/`validate`; replace `get(` with `getOrThrow(` where there is no safe default; add `.env*` to `.dockerignore`; move `ENV SECRET=…` lines out of the Dockerfile into runtime secrets. If a real secret was ever committed or baked into an image, tell the user it must be **rotated** — deleting the file does not remove it from git history or pushed images.

---

## 2. Handle SIGTERM and get the container right

**Why it matters.** Every deploy, scale-down and node drain sends SIGTERM. If Nest's shutdown hooks are not enabled, `onModuleDestroy`/`onApplicationShutdown` never run: DB pools, queue consumers and in-flight work are cut off mid-operation. If Node is started through a shell (`CMD npm start`, shell-form `CMD node …`), `/bin/sh` is PID 1 and does not forward the signal, so the container just gets SIGKILLed after the grace period. Node as PID 1 also doesn't get default signal handling.

**What good looks like.**

```ts
// main.ts
app.enableShutdownHooks();
// If Node runs as PID 1 with no init process:
app.enableShutdownHooks(undefined, { useProcessExit: true });
```

```dockerfile
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
# ~75% of the container memory limit (here: 1 GiB limit)
ENV NODE_OPTIONS="--max-old-space-size=768 --enable-source-maps"
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
USER node
CMD ["node", "dist/main.js"]
```

Run with an init process — `docker run --init`, `init: true` in compose, or `tini` as `ENTRYPOINT` — or use `useProcessExit: true`.

**Scanner looks for.** `enableShutdownHooks`; `useProcessExit`/`--init`/`tini`/`dumb-init`; final-stage `CMD`/`ENTRYPOINT` form and whether it goes through npm/yarn/pnpm; number of `FROM` stages; final-stage `USER`; `NODE_ENV=production`; `--max-old-space-size` anywhere in Dockerfile, manifests, compose or scripts.

**Verify by hand.**
- The heap limit should be ≈75% of the *actual* container memory limit — read the k8s `resources.limits.memory` (or platform setting) and do the math. Leaving room for buffers, native memory and the rest of the process matters.
- Some platforms (Cloud Run, Fly, Heroku) inject their own init or start command — check the platform config before flagging.
- Distroless images already run as non-root when using the `:nonroot` tag.
- If there is no Dockerfile (buildpacks, Nixpacks, Railway, Render), read the platform's start command instead.

**Fix.** Add `app.enableShutdownHooks()` right after `NestFactory.create`; convert `CMD` to exec form calling `node` directly; add a build stage, `USER node`, `NODE_ENV=production`, and a heap limit sized from the memory limit.

---

## 3. Drain before you close

**Why it matters.** When a pod is told to stop, removal from Service endpoints / load balancer target groups happens *asynchronously*. For a few seconds, traffic keeps arriving at a process that is already closing — those requests get connection resets. A short pre-stop delay keeps the process serving while the endpoint removal propagates; answering 503 during shutdown gives clients something retryable instead of a reset. Kubernetes SIGKILLs after `terminationGracePeriodSeconds` (default 30), and the pre-stop time counts against it.

**What good looks like.**

```yaml
spec:
  terminationGracePeriodSeconds: 45   # preStop + longest request/job + margin
  containers:
    - name: api
      lifecycle:
        preStop:
          exec:
            command: ["sleep", "5"]
          # Images without a shell/sleep (distroless): Kubernetes 1.30+ supports
          # preStop: { sleep: { seconds: 5 } }
```

```ts
// @nestjs/core ≥ 12.0: answer 503 (retryable) instead of accepting and then dropping requests while closing
const app = await NestFactory.create(AppModule, { return503OnClosing: true });
```

Long-running jobs must fit inside the grace period, and must be **idempotent** — a crash or SIGKILL means they will be restarted from the top.

**Scanner looks for.** `return503OnClosing: true` (and whether the installed Nest typings contain it); `preStop` and `terminationGracePeriodSeconds` in Kubernetes manifests.

**Verify by hand.**
- Longest request / job duration vs the grace period.
- **EKS behind an AWS ALB** (the most common setup): with the AWS Load Balancer Controller in IP mode, the ALB deregisters the pod on its own schedule. The target group's deregistration delay defaults to 300s, and deregistration can take longer than a 5s `preStop` sleep. Common practice:
  - Use a longer `preStop` sleep, often 15–30s.
  - Enable pod readiness gates (`elbv2.k8s.aws/pod-readiness-gate-inject: enabled` on the namespace) so rollouts wait for the ALB.
  - Tune `deregistration_delay.timeout_seconds` down to what your requests need.
  - Keep `terminationGracePeriodSeconds` longer than all of the above combined.

  Point to the controller's docs; don't present these numbers as universal.
- Other non-Kubernetes platforms: how do they drain? On ECS it's the target-group deregistration delay; Cloud Run and Fly manage it for you. Report what that platform's docs say; don't guess.
- Queue workers (BullMQ etc.) should stop taking new jobs on shutdown and let active ones finish — check `onApplicationShutdown` / worker `close()`.

**Fix.** Add the `preStop` delay (5s is a common default), size `terminationGracePeriodSeconds`, and enable `return503OnClosing` where available.

---

## 4. Scheduled jobs run on every replica

**Why it matters.** `@Cron()`, `@Interval()` and `@Timeout()` from `@nestjs/schedule` run in *every* process. With three replicas the nightly billing job runs three times; during a rolling deploy old and new pods overlap and it can run again. `@Timeout` runs once per process start — i.e. per replica, per deploy.

**What good looks like.** Per the NestJS checklist, `@nestjs/locks` (supports Nest 11 and 12, early 0.0.x release) guards handlers with a lock held in a shared store (Redis or Postgres):

```ts
@Cron('0 * * * *')
@OnOneInstance({ key: 'hourly-digest' })   // only one replica runs each tick
async sendDigest() { … }

@Interval(10_000)
@WithoutOverlapping()                        // a slow run doesn't overlap the next tick
async syncInventory() { … }
```

- `LocksModule` needs a real `LockStore` (Redis/Postgres) in production. It refuses the in-memory store there unless `allowInMemoryStorage` is set, and that store only excludes callers **in the same process**.
- The 0.0.x package ships **only** the in-memory store. You implement `LockStore` for Redis or Postgres yourself, with atomic acquire, fencing tokens, and compare-and-set renew and release. It's also ESM-only and needs Node ≥ 20.19. See `version-notes.md`.
- Write jobs to process *current state* ("send every digest not yet sent") rather than "what happened since the last tick" — ticks get skipped during deploys and under lock contention.
- For work that must happen exactly once per event, a queue (e.g. `@nestjs/bullmq` with `attempts`, `backoff`, `removeOnComplete`/`removeOnFail`) is usually the better tool than cron.

**Fallback on older Nest / without @nestjs/locks.**

- **Claim each tick once, with a key that expires (best for cron).** Before doing any work, the job claims a key for this specific tick, for example `cron:digest:2026-09-30T14`, using `SET key owner NX PX <ttl>`. Set the TTL to about 2× the interval. **Don't release the key when the job finishes.** If you did, a pod whose clock runs a second behind could claim the same tick after the first pod finished, and the job would run twice.
- **Hold a lock while the job runs.** A Postgres advisory lock (`pg_try_advisory_xact_lock`) or a Redis lock stops runs from overlapping, which is what `@WithoutOverlapping` does. On its own it doesn't stop two pods running the same tick one after the other. (`redlock`'s current major is a 5.0 beta, so say so if you suggest it.)
- **Let Redis coordinate the schedule.** BullMQ repeatable jobs do this, and they add retries.
- **Take the schedule out of the app.** A Kubernetes `CronJob` can run a one-shot command instead.

Decide what happens when the lock store is unreachable. Skipping the run (and logging an error that someone gets alerted on) is usually safer than running on every replica. Say which you chose.

Most of these give *at-most-once* per tick. If the pod crashes halfway, that tick's work is lost unless the job processes state ("send every digest not yet sent") rather than "this hour's batch".

**Scanner looks for.** `@Cron`/`@Interval`/`@Timeout` and, near each, `@OnOneInstance`/`@WithoutOverlapping` or common lock patterns in the handler body: advisory locks, redlock, `SET … NX`, `setnx`, `acquire`/`claim`/`tryLock` calls. It also flags `allowInMemoryStorage: true`. Custom lock helpers with other names are missed. Put a `// preflight-ignore: 4 <reason>` comment on or above the decorator line, and the scanner will move that finding to a suppressed note.

**Verify by hand.**
- Truly single-instance deployments (one replica, `Recreate` strategy) can downgrade FAIL → WARN — but note that scaling up later silently breaks the job.
- Handlers that are naturally idempotent and cheap (e.g. refreshing an in-memory cache per process) are *meant* to run on every replica — downgrade to PASS with a note.
- Is the job idempotent if it crashes halfway?

**Fix.** Add the lock decorator (or fallback), configure a shared `LockStore`, and make the job idempotent.
