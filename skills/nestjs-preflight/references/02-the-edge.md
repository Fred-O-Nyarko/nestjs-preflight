# The edge (checks 5–6)

---

## 5. Authentication is deny-by-default

**Why it matters.** With per-route `@UseGuards(AuthGuard)`, security depends on every developer remembering the decorator on every new route, forever. One forgotten decorator is a public endpoint. With a global guard, forgetting something makes a route *more* locked down, and the unauthenticated surface becomes a greppable list of `@Public()` decorators — a security review becomes "check each exception".

**What good looks like.**

```ts
// public.decorator.ts
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

// auth.guard.ts
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector /*, token service… */) {}
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // …verify the session / bearer token, attach the user, or throw UnauthorizedException
  }
}

// app.module.ts
providers: [{ provide: APP_GUARD, useClass: AuthGuard }]

// health.controller.ts
@Public()
@Get('live') live() { return { status: 'ok' }; }
```

The NestJS checklist also describes `@nestjs/authentication`, whose `AuthenticationModule` registers a global guard out of the box (every route requires a signed-in user, otherwise 401) and covers sessions, JWT bearer tokens, OpenID Connect, magic links and API keys. Recommend it only after confirming the package is available for the project's Nest version.

**Scanner looks for.** `APP_GUARD` / `useGlobalGuards` with an auth-looking guard class; `AuthenticationModule`; per-route `@UseGuards(...)` with auth-looking guards; public-marker decorators (`@Public`, `@AllowAnonymous`, `@SkipAuth`, …).

**Verify by hand.**
- Open the global guard: does it actually deny when no credentials are present, or does it just decorate the request?
- List every `@Public()` route and ask whether each should be public. Health checks, login, signup, webhooks (with signature verification) are typical.
- GraphQL resolvers, WebSocket gateways and microservice handlers: guards need `GqlExecutionContext` / WS context handling — check the guard supports every transport the app uses.
- Authorization (roles/ownership) is a separate question — note gaps, but this check is about *authentication* defaulting to deny.
- Internal-only services behind an authenticating gateway or service mesh may legitimately have no auth guard: ask, and record the assumption.

**Fix.** Move the guard to `APP_GUARD`, add a `@Public()` decorator, apply it to the routes that must be public, and remove the now-redundant per-route guards. Run the e2e tests — anything that breaks was relying on being public.

---

## 6. Security headers, CORS, rate limits, trust proxy

**Why it matters.**
- **Headers.** CSP, HSTS, `X-Content-Type-Options`, frame options etc. are cheap defense in depth. Missing headers are a WARN, not a FAIL.
- **CORS.** `cors: true` / `enableCors()` with no options sends `Access-Control-Allow-Origin: *`: any website can read your non-credentialed responses. That's usually not what you want, but browsers won't combine `*` with credentials. `origin: true` is worse: it *reflects* whatever origin asks, so combined with `credentials: true` any website can make authenticated requests with your users' cookies. The scanner treats `*` as WARN and `origin: true` as FAIL.
- **Rate limits.** Login, signup, password reset, OTP verification and any expensive endpoint are brute-force and cost-amplification targets.
- **Trust proxy.** Behind a load balancer or ingress, `req.ip` is the proxy's IP and `req.protocol` is `http`. Rate limits then key on one IP (everyone shares a bucket), audit logs lie, and secure cookies / redirects misbehave. Setting it to `true` is the opposite mistake — any client can spoof `X-Forwarded-For`. Set it to the actual number of proxy hops.

**What good looks like.**

```ts
// @nestjs/core ≥ 12.1 — built-in security headers, with optional CSP directives
app.useSecurityHeaders();
// app.useSecurityHeaders({ contentSecurityPolicy: { directives: { /* … */ } } });

// older Nest (Express): helmet
import helmet from 'helmet';
app.use(helmet());
// Fastify: await app.register(require('@fastify/helmet'));

app.enableCors({ origin: ['https://app.example.com'], credentials: true });

// Express adapter
app.set('trust proxy', 1); // one hop: the load balancer
// Fastify adapter: new FastifyAdapter({ trustProxy: 1 })
```

```ts
// app.module.ts
imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],

// tighter limit on sensitive routes
@Throttle({ default: { limit: 5, ttl: 60_000 } })
@Post('login') login() { … }
```

Note: `@nestjs/throttler`'s default storage is in-memory, so each replica counts separately; with several replicas, use a shared storage (e.g. a Redis storage adapter) or accept limits that are N× looser.

**Scanner looks for.** `useSecurityHeaders`/`helmet`; `cors: true`, `enableCors()` without options, `origin: true`/`'*'`; `ThrottlerModule` and `ThrottlerGuard`; `trust proxy` / `trustProxy` and whether it is `true`.

**Verify by hand.**
- How many proxies sit in front (CDN → LB → ingress = 2 or 3)? Ask if unknown.
- If CORS origins come from config, read the production value.
- Check whether `credentials: true` is set together with a permissive origin. That combination makes it a FAIL.
- An API that only serves server-to-server clients may not need CORS at all — not enabling it is fine.
- CSP defaults can break Swagger UI or server-rendered pages — test before enabling strict directives.

**Fix.** Add headers, restrict CORS to explicit origins, add ThrottlerModule with a global guard and stricter per-route limits, set `trust proxy` to the hop count.
