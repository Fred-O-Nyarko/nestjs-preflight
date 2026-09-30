# Errors and visibility (checks 16–17)

---

## 16. Errors: statuses, logs, source maps

**Why it matters.** Nest's default exception handling is already right: `HttpException`s keep their status and message, everything else becomes an opaque `500 Internal server error` *and* is logged with its stack by `ExceptionsHandler`. Custom catch-all filters often break one of those — leaking internals to clients, turning everything into 500 (or 200), or dropping the stack. Swallowing `unhandledRejection` keeps a process alive in an unknown state; since Node 15 the default is to crash, which is correct — the orchestrator restarts it. Without source maps, production stack traces point at compiled `dist/*.js` lines.

**What good looks like.**

```ts
// Customize the shape, keep the semantics and the logging
@Catch()
export class AppExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    // add a trace ID, report to your error tracker, etc.
    super.catch(exception, host);
  }
}
// main.ts
const { httpAdapter } = app.get(HttpAdapterHost);
app.useGlobalFilters(new AppExceptionFilter(httpAdapter));
```

```dockerfile
CMD ["node", "--enable-source-maps", "dist/main.js"]
# or ENV NODE_OPTIONS="--enable-source-maps"
```

`tsconfig.json` must emit maps (`"sourceMap": true`, the Nest default) and the `.map` files must be copied into the runtime image.

If the app registers `process.on('unhandledRejection' | 'uncaughtException')`, the handler should log the error with its stack and then exit (`process.exit(1)`), not continue.

**Scanner looks for.** `@Catch()` catch-all filters not extending `BaseExceptionFilter` and/or not logging; `process.on('unhandledRejection'|'uncaughtException')` handlers without `process.exit`/rethrow; `--enable-source-maps`/`source-map-support`; `"sourceMap": false`.

**Verify by hand.**
- Open each custom filter: does a non-`HttpException` produce a 500 with a generic message? Is the stack logged (or sent to the error tracker)?
- Does the Dockerfile copy `dist/**/*.map`? (`COPY dist ./dist` does; some builds exclude maps.)
- Throwing plain `Error`s for client mistakes (e.g. "not found") produces 500s — they should be `NotFoundException` etc. Sample a few services.

**Fix.** Rebase custom filters on `BaseExceptionFilter`; make process handlers log-and-exit; add `--enable-source-maps`.

---

## 17. Logs, health checks, monitoring

**Why it matters.** In production you debug through logs, metrics and traces — nothing else. Plain-text logs can't be queried; logs without a trace ID can't be joined into one request. A liveness probe that checks the database means a database blip makes Kubernetes restart every healthy pod at once. Without per-route latency/error metrics and grouped errors with alerts, users find your incidents before you do.

**What good looks like.**

```ts
// JSON logs, production levels (built into ConsoleLogger on recent Nest)
const app = await NestFactory.create(AppModule, {
  logger: new ConsoleLogger({ json: true, logLevels: ['log', 'warn', 'error', 'fatal'] }),
});
// or nestjs-pino / winston

// Structured parameters instead of string interpolation
this.logger.log({ msg: 'order created', orderId, userId });
```

```ts
@Controller('health')
export class HealthController {
  constructor(private health: HealthCheckService, private db: TypeOrmHealthIndicator) {}

  @Public() @Get('live')        // the process is up and the event loop responds — no dependency checks
  live() { return { status: 'ok' }; }

  @Public() @Get('ready') @HealthCheck()   // can we serve traffic right now?
  ready() { return this.health.check([() => this.db.pingCheck('database')]); }
}
```

```yaml
livenessProbe:  { httpGet: { path: /health/live,  port: 3000 } }
readinessProbe: { httpGet: { path: /health/ready, port: 3000 } }
```

- A trace ID (OpenTelemetry, or a request ID via `nestjs-cls`) on every log line.
- Monitoring with per-route latency and error rate, errors grouped by defect, and an alert when a *new* error appears. Instrumenting through the DI container (rather than only HTTP middleware) also covers queues, cron and microservice handlers. The NestJS team's checklist mentions its own hosted option (NestJS Observe, `ObserveModule`); OpenTelemetry, Sentry, Datadog, New Relic and others work too — recommend whatever the team already uses.
- Exclude health endpoints from request logs/traces to keep noise down.

**Scanner looks for.** Health routes (`live`/`ready`/`health`…), `@nestjs/terminus`; dependency checks inside liveness handlers; identical liveness/readiness probe paths in manifests; JSON logging (`ConsoleLogger({ json: true })`, pino, winston…); trace/request IDs; APM/error-tracking packages.

**Verify by hand.**
- Production log level: is `debug`/`verbose` on in production?
- Are logs actually shipped somewhere searchable? (Ask.)
- Is there an alert on error rate or new errors, and who receives it? (Ask — this is often the real gap.)
- Health endpoints must be excluded from auth (`@Public()`) and rate limiting.

**Fix.** Split health endpoints and probes, switch to JSON logging with a trace ID, and wire up the team's monitoring tool.
