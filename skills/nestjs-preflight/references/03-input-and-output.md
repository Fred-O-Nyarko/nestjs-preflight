# Input and output (checks 7–9)

---

## 7. Validate every input

**Why it matters.** Without a global pipe, DTO classes are only TypeScript types — erased at runtime. Any JSON reaches your services. Without `whitelist`, extra properties flow into `repository.save(dto)` (mass assignment: `{ "role": "admin" }`). Unbounded list endpoints let one request load a whole table. Raising the body size limit lets every client make the server buffer that much memory per request.

**What good looks like.**

```ts
// class-validator DTOs
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,              // strip unknown properties
  forbidNonWhitelisted: true,   // …and reject the request so clients learn about typos
  transform: true,              // query strings → numbers/booleans per the DTO
}));

// recent Nest — Standard Schema (Zod, Valibot, ArkType…)
app.useGlobalPipes(new StandardSchemaValidationPipe());
@Post() create(@Body({ schema: createUserSchema }) body: CreateUser) { … }
// Use strict objects (z.strictObject) to reject unknown keys.
```

```ts
// Bounded pagination
export class ListQuery {
  @IsInt() @Min(1) @Max(100) @Type(() => Number)
  limit: number = 20;
}
// Zod: limit: z.coerce.number().int().min(1).max(100).default(20)
```

- Keep the default body limit (100 KB for JSON on the Express adapter). Stream large uploads on dedicated routes (multipart, pre-signed object-storage URLs) instead of raising the global limit. If a route truly needs more, raise it for that route only.

**Scanner looks for.** `useGlobalPipes`/`APP_PIPE`; `ValidationPipe` options; Standard Schema / Zod pipes; body limits ≥ 5 MB; pagination-looking DTO fields (`limit`, `take`, `pageSize`, `perPage`, …) without `@Max`/`.max()`.

**Verify by hand.**
- Controllers that take `@Body() body: any` or raw `@Req()` bypass validation even with a global pipe.
- `@Query()` params declared as primitives (`@Query('limit') limit: number`) are strings unless transformed — and unbounded.
- WebSocket gateways and microservice handlers in a hybrid app: `app.useGlobalPipes()` doesn't set up pipes for them. Apply `@UsePipes(...)` on the gateway/handler, or pass `{ inheritAppConfig: true }` to `connectMicroservice()`.
- File uploads: `FileInterceptor` limits (`limits: { fileSize }`).

**Fix.** Register the global pipe with the options above, add bounds + defaults to pagination DTOs, and revert raised global body limits in favor of per-route handling.

---

## 8. Control what goes out

**Why it matters.** Returning an ORM entity sends *every column it has today and every column someone adds tomorrow* — password hashes, reset tokens, internal flags, soft-delete timestamps. Response shapes also leak implementation details (internal IDs, join tables, error internals). Swagger in production publishes a map of every endpoint and schema.

**What good looks like.**

```ts
// Option A — explicit response DTOs (preferred)
return UserResponse.from(user); // maps only the fields you intend to expose

// Option B — class-transformer exclusion
@Entity() export class User {
  @Exclude() @Column({ select: false }) passwordHash: string;
}
app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
// ClassSerializerInterceptor only works on class instances — plain objects from
// query builders / raw queries are sent as-is.

// Swagger only outside production (or behind auth)
if (config.getOrThrow('NODE_ENV') !== 'production') {
  SwaggerModule.setup('docs', app, document);
}
```

Prisma returns every scalar field by default — use `select`/`omit` or map to DTOs.

**Scanner looks for.** `SwaggerModule.setup` without an environment/config guard nearby; sensitive-looking fields on TypeORM/Mongoose/Sequelize entities without `@Exclude()`/`select: false`; sensitive fields in Prisma schemas; presence of `ClassSerializerInterceptor`/DTO mapping.

**Verify by hand.**
- Open 3–5 controllers with GET/list endpoints: do they `return this.repo.find(...)` directly?
- Relations: eager-loaded relations can drag in sensitive nested entities.
- Error responses: do custom filters include `exception.stack` or raw DB errors?
- If Swagger must stay in production (public API docs), it should be behind auth or intentionally public — ask.

**Fix.** Introduce response DTOs for the risky endpoints (or `@Exclude` + `ClassSerializerInterceptor` as a quicker stopgap), and gate `SwaggerModule.setup`.

---

## 9. Make writes safe to repeat

**Why it matters.** Networks fail *after* the server processed the request but *before* the client got the response. Clients, SDKs, proxies and users (double-click) retry. Without idempotency, a retried "charge card" or "create order" happens twice.

**What good looks like.** The NestJS checklist describes `@nestjs/idempotency`: clients send an `Idempotency-Key` header, the server stores the first response in a shared store (Redis or Postgres) and replays it for retries with the same key (replayed responses carry `Idempotent-Replayed: true`; the default TTL is 24 hours). Reusing a key with a *different* body returns 422, which surfaces client bugs.

```ts
IdempotencyModule.forRoot({
  // store: Redis/Postgres-backed store (shared across replicas)
  scope: (req: { user?: User }) => req.user?.id, // keys are per user
});

@Post('charge')
@Idempotent({ required: true }) // reject requests without an Idempotency-Key
charge(@Body() body: ChargeDto) { … }
```

The 0.0.x package ships only an in-memory store. With several replicas you implement its store interface on Redis or Postgres yourself. It's also ESM-only and needs Node ≥ 20.19 (see `version-notes.md`).

**Fallback without the package.** A unique constraint on a client-supplied request ID / idempotency key column, checked inside the same transaction as the write; or an interceptor that stores `(user, key) → response` in Redis with `SET NX`. Payment providers (Stripe etc.) accept an idempotency key on their side too — pass one through.

**Scanner looks for.** POST handlers whose route/method name looks payment- or order-like (`pay`, `charge`, `order`, `checkout`, `transfer`, `refund`, `payout`, `booking`, …) without `@Idempotent`; any idempotency infrastructure.

**Verify by hand.** This check is mostly judgment. Ask: which writes would hurt if applied twice? Money movement, order creation, sending messages/emails, provisioning resources, inventory decrements. Webhook receivers should dedupe on the provider's event ID.

**Fix.** Add idempotency to the endpoints that move money or create side effects, with a shared store and `required: true`; make the frontend/SDK send a key generated once per user action.
