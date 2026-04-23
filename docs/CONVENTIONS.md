# CONVENTIONS.md

Conventions that apply to every line of code in this repository. Read before every PR. Deviations must be justified in the commit message.

---

## TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- Target: ES2022. Module: ESM. `moduleResolution: 'Bundler'`.
- **No `any`.** Use `unknown` and narrow. If you truly need `any`, add `// eslint-disable-next-line` with a one-line reason.
- `type` for DTOs and return shapes. `interface` for class contracts.
- Shared DTOs live next to their Zod schema in `<module>.schemas.ts`. Use `z.infer<typeof Schema>` as the canonical type.
- No default exports except for config-style singletons (`db`, `redis`, `logger`).

---

## Mongoose

- All models in `src/shared/models/`. Filename: `User.model.ts`. Export schema AND model.
- `timestamps: true, versionKey: false`.
- `toJSON` transform strips `_id` and `__v`, adds `id`.
- Indexes declared at the bottom of the file with a one-line comment explaining the query path.
- Repositories return `.lean()` for reads. Hydrated docs only when mutating.
- No `.save()` in controllers. Only services call repositories.
- Never expose Mongoose documents to the HTTP layer. Map to plain DTOs at the service boundary.

### Transactions — pitfalls and patterns

#### Punitive writes on throw

When a service method aborts a Mongo transaction by throwing, any writes inside the transaction callback roll back with it. If the throw represents a policy violation that also needs to be recorded or acted upon (audit log, rate limit, family revoke, fraud score), that write MUST happen in the outer scope after the transaction has resolved, not inside the callback that throws. Use a flag returned from the transaction body (e.g. `{ raceDetected: true }`) and branch on it outside.

#### Duplicate-key writes inside transactions

A failed write inside a Mongo transaction aborts the session state immediately, regardless of whether the Mongoose layer catches the error. Subsequent reads or writes in the same callback will throw `NoSuchTransaction`, which `withTransaction` reclassifies as `TransientTransactionError` and retries the callback — causing infinite retry loops if the duplicate condition remains.

Repository helpers that swallow duplicate-key errors (`insertIfAbsent`, `findOrCreate`, similar) are safe only OUTSIDE transactions. Inside a transaction, use one of:

1. `updateOne(filter, { $setOnInsert: {...} }, { upsert: true, session })` — branch on `upsertedId` to detect fresh insert vs existing row. No write failure on match. Transaction stays alive. Use this for idempotent "create if missing, continue either way" flows (post-completion, device-fingerprint upsert on login).

2. `insertOne` with intentional throw on duplicate — use when the duplicate case is a user-facing error the service means to signal (vote-already-cast, code-already-copied). The transaction SHOULD abort on duplicate; you're not continuing past it.

Rule: if the service needs to do ANY further work inside the transaction after the potentially-duplicate write, use pattern 1. If the duplicate is the terminal branch (throw and return), pattern 2 is fine.

#### Advisory pre-checks vs atomic predicates

For state-machine flips where a single atomic op carries the correctness guarantee (FCFS redeem-code claim, custom-room state transitions, daily-vote dedup), the atomic `findOneAndUpdate` predicate IS the gate. Pre-checks that run before the op are advisory only — nice error messages, fast short-circuits — but they must not be treated as load-bearing.

Discipline:

- **The predicate is the gate.** Pre-checks exist to return a friendly error before a no-op write. A race between the pre-check and the atomic op is always possible; the predicate must cover the race.
- **Do not "fix" races with a two-phase CAS.** Reading-then-checking-then-updating adds a round trip without adding guarantees. If a pre-check passes but the atomic op fails the predicate, the caller already has the right error (CODE_TAKEN, VOTE_ALREADY_CAST).
- **Do not wrap in a transaction just for this.** A single atomic op is already atomic at the document level; a transaction adds cost and creates retry-loop risk on transient mongo errors.
- **Accept the millisecond race window for non-money, non-compliance flows.** User-blocked-mid-claim is a ~ms window versus a multi-second admin workflow; the Phase 7 fraud sweep catches any exotic drift at zero incremental complexity. Reach for hard guarantees only where the write is irreversible (money, prize allocation, vote cast) AND the adversary can reliably hit the window.

Concrete examples in the codebase:

1. **FCFS redeem-code claim** — `src/modules/redeem-codes/redeem-codes.service.ts` `claim()`. Pre-checks: code exists + has postId, user not blocked, post completed. Atomic op: `findOneAndUpdate({_id, status: 'PUBLISHED'}, {$set})`. The `status: 'PUBLISHED'` predicate is the only gate the race against admin-void or concurrent-copy has to pass.

2. **Webhook idempotency via `$setOnInsert` on eventId** — `src/modules/webhooks/webhooks.service.ts` `handleRazorpayWebhook()`. Pre-check: `findOne({eventId})` for friendly short-circuit on already-DONE events. Atomic op: `findOneAndUpdate({eventId}, {$setOnInsert: {...status: 'PROCESSING'}}, {upsert: true, new: false, rawResult: true})`. The upsert's `updatedExisting` flag is the single-winner gate: exactly one concurrent caller sees `false` and owns dispatch; everyone else reads the pre-existing row's status and routes to `duplicate` / `concurrent` / reclaim. A naive `findOne`-then-`upsert` loses this — two concurrent deliveries both read null and both dispatch.

3. **Multi-level idempotency — WebhookEvent gate PLUS razorpayPaymentId unique** — `src/modules/subscriptions/subscriptions.service.ts` `onCharged()`. The WebhookEvent table guards against duplicate _deliveries_; the `razorpayPaymentId` unique index inside the charged-handler's `withTransaction` guards against duplicate _processing_ of the same payment even if the event-level gate is ever bypassed. Pattern 1 (`updateOne + $setOnInsert + upsert, branch on upsertedId`) detects insert-winner vs. re-run and commits a harmless no-op on the re-run. Defence in depth: the invoice numbering upstream of this handler is irreversible, so losing the race twice would mint a duplicate invoice — two independent predicates prevent it.

4. **Daily prize-pool computation** — `src/modules/prize-pools/prize-pools.service.ts` `computeAndPublishPool()`. `PrizePool` has a unique index on `dayKey`. The pattern-1 upsert (`findOneAndUpdate + $setOnInsert + upsert, rawResult: true`) is the gate: insert-winner returns `{created: true}` with its freshly-computed values; race-loser reads `updatedExisting: true` and returns `{created: false}` with the pre-existing row's values (deterministic re-run semantics — caller sees what the original insert-winner computed, not a fresh compute that could disagree if AppConfig changed between runs). Phase 7's midnight-IST BullMQ cron relies on this for at-least-once delivery safety.

5. **BullMQ job idempotency + domain-level predicate = belt-and-suspenders** — `src/workers/*.ts`. Every worker handler runs under BullMQ's at-least-once delivery guarantee (retries on crash, repeat-scheduler fires, manual re-enqueues). The domain-level gate (Pattern 1 upsert for prize-pool, convergent predicate for tier-sweep / reconcile-codes, `razorpayPaymentId` unique for invoice generation, status predicate for webhook-retry) is the correctness guarantee; BullMQ's `jobId` dedup is the cheap first line of defence. Duplicate handler invocations that slip past the jobId layer still produce correct outcomes.

#### jobId strategy — loose vs stable

A corollary of "the predicate is the gate" that surfaced in Phase 7: the jobId strategy for enqueued BullMQ jobs depends on whether the domain layer is convergent or first-writer-wins.

- **Convergent-state predicates tolerate loose jobIds.** `sweepExpiredTiers` uses `{tier: $ne: 'PUBLIC'}` — duplicate continuation jobs all see the same filter and flip only still-expired users. Using `tier-sweep-continue-${Date.now()}` (unique per enqueue, so BullMQ dedup never fires) is correct: duplicate continuations are harmless, and a stable jobId would block legitimate parallel batches without adding safety. Pattern visible in `src/worker.ts`'s `enqueueContinuation`.
- **Pattern 1 upserts demand stable jobIds.** `enqueueInvoice({paymentId})` uses `jobId: invoice-${paymentId}` so BullMQ blocks duplicate enqueues. Without this, two enqueues from webhook retries would both attempt the `$setOnInsert` on `SubscriptionPayment` — the second no-ops correctly at the Mongo layer, but the invoice handler does external side effects (KMS, S3, SES) that cost money and mailbox space per fire. Stable jobId saves redundant work; the domain is safe either way.
- **Rule of thumb:** if the handler's domain layer is already idempotent via Mongo predicate AND has no external side effects, a loose jobId is acceptable. If the handler touches KMS / S3 / SES / any external API, use a stable jobId to minimise redundant firing. Correctness follows from the Mongo layer; jobId stability is a cost optimisation.

#### Set-operators and counters drift

When a set-modifying operator (`$addToSet`, `$pull`, `$push` with the right flags) may be a no-op AND an `$inc` on a denormalized counter is bundled into the same atomic update, the `$inc` fires regardless of whether the set-op changed anything. Every duplicate call drifts the counter away from the array's actual length.

```ts
// ✗ WRONG — double-counts on repeat registrations:
await Room.updateOne(
  { _id },
  {
    $addToSet: { registeredParticipants: userId }, // may no-op
    $inc: { participantCount: 1 }, // always fires
  },
);
```

Correct pattern: split into two atomic ops. First the set operator with `new: false`, inspect the pre-state array to see whether the set actually modified anything, then conditionally `$inc`.

```ts
// ✓ Right — $inc only fires on a fresh add.
const pre = await Room.findOneAndUpdate(
  { _id, ...cap-and-status-predicates... },
  { $addToSet: { registeredParticipants: userId } },
  { new: false },
);
if (!pre) { /* disambiguate the 4 failure modes via a follow-up read */ }

const wasAlreadyInSet = pre.registeredParticipants.some(id => String(id) === String(userId));
if (wasAlreadyInSet) return { alreadyRegistered: true };

await Room.updateOne({ _id }, { $inc: { participantCount: 1 } });
```

Additional discipline:

- **Prefer computed reads at the boundary.** When a list API can compute the counter from the array (`registeredParticipants.length`), do that instead of reading the denormalized field. The counter is still useful for aggregations / indexed queries where touching the array would be expensive, but user-facing reads should trust the authoritative source.
- **Six-branch disambiguation for set-op results.** The pre-state inspection replaces a naive pre-read-then-write check. Failure modes collapse into: fresh-add / already-in-set / not-found / wrong-state / cap-full / internal-fallback. Throwing the wrong error code for any of these is a correctness bug — a cap-full room where the user is already registered MUST return `alreadyRegistered: true`, not `ROOM_FULL`.

Concrete in-tree example: `src/modules/custom-rooms/custom-rooms.service.ts` `register()`. Phase 6 Chunk 1 caught the `$addToSet + $inc` drift; the service now performs two atomic ops plus a disambiguation read on the error path.

---

## Express

- One router per module, mounted by name in `src/modules/<module>/index.ts`.
- Controllers never `try/catch`. `express-async-errors` is loaded at boot. Throw `AppError` subclasses.
- Zod validation middleware runs before the controller: `validate(Schema, 'body' | 'query' | 'params')`. On failure throws `ValidationError`.
- Response envelope (always):
  ```json
  { "success": true, "data": { ... } }
  { "success": false, "error": { "code": "ERR_CODE", "message": "...", "details": {} } }
  ```
- Route file exports only the router. Controller logic lives in `<module>.controller.ts`. Service in `<module>.service.ts`. Repository in `<module>.repository.ts`.

---

## Money

- **All amounts are integer paise** at the boundary, in storage, and in calculations. Never floats.
- ₹50 = `5000`. ₹118 = `11800`.
- UI converts at the edge: `paise / 100 = INR display`.
- Display-only helpers in `src/shared/utils/money.ts`.

---

## Dates and timezones

- Default timezone for scheduling, day keys, and cron: **Asia/Kolkata (IST)**.
- Use `dayjs` with `utc` and `timezone` plugins.
- `dayKey` format is always `'YYYY-MM-DD'` in IST.
- Never compute dates with `new Date()` directly in business logic. Go through `src/shared/utils/date.ts`.

---

## Errors

Hierarchy in `src/shared/errors/`:

- `AppError` (base)
  - `BadRequestError` (400)
  - `ValidationError` (400). Carries Zod issues.
  - `UnauthorizedError` (401)
  - `PaymentRequiredError` (402). `INSUFFICIENT_COINS`.
  - `ForbiddenError` (403)
  - `NotFoundError` (404)
  - `ConflictError` (409). `VOTE_ALREADY_CAST`, `CODE_TAKEN`.
  - `UnprocessableError` (422)
  - `RateLimitedError` (429)
  - `GeoBlockedError` (451)
  - `InternalError` (500)

Every error carries `code` (string, matches `docs/API.md` §12), `httpStatus`, `message`, optional `details`. Sentry tags events by `code`.

---

## Logging

- `pino` with structured JSON. One line per event.
- Redaction list: `req.headers.authorization`, `password`, `otp`, `otpHash`, `*.codeCt`, `*.codeIv`, `*.codeTag`, `*.codeDekEnc`, `*.panCt`, `*.panIv`, `*.panTag`.
- Every request logged with `reqId`, `userId` (if authed), `method`, `path`, `status`, `durationMs`.
- Use `logger.child({ module: 'votes' })` per module for filtering.
- Never log raw request bodies that might contain sensitive data.

---

## Tests

- Unit tests live next to source: `auth.service.spec.ts`.
- Integration tests in `test/integration/<feature>.spec.ts` against `mongodb-memory-server`.
- Coverage gate: 80% lines on services, 70% overall. Do not chase 100%.
- Every atomic guarantee (vote uniqueness, FCFS race, post completion idempotency) must have a concurrency test that spawns N parallel calls.
- Webhook handlers must have signature-verification and idempotency tests.
- Name tests with behavior, not implementation: `"rejects second vote on same day"`, not `"test_VoteService_vote_duplicate"`.

---

## Dependency injection

- `awilix` composition root in `src/container.ts`.
- Register by service name (`authService`, `voteRepository`, etc.).
- Controllers receive services via constructor injection (for classes) or closure (for functional controllers).
- Singletons: config, logger, db connection, redis, Razorpay SDK, S3 client.
- Scoped: per-request context if needed (unused in MVP).

---

## Commits

- **Conventional commits.** Format: `type(scope): subject`.
- Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`.
- Scopes: module name. `auth`, `votes`, `payments`, `infra`, `deps`, etc.
- Subject: imperative, lowercase, no period. Max 72 chars.
- Body: optional, wrapped at 100. Explain why, not what.
- One logical change per commit. No `wip` pushes to main.

Examples:

- `feat(auth): add refresh token rotation with family tracking`
- `fix(votes): race between two parallel vote calls`
- `chore(deps): bump razorpay from 2.9.5 to 2.9.6`

---

## Branching

- `main` is protected. Deploys to staging on merge.
- `prod` is fast-forward-only from `main` after manual approval.
- Feature branches: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`.
- PRs must include:
  - A short description of what changed and why.
  - Test evidence (new tests, CI passing).
  - "Compliance impact" checkbox: did this change touch PROGA-adjacent features, money flows, or user data?

---

## File organisation

Module layout:

```
src/modules/<feature>/
├── index.ts                     # mount routes
├── <feature>.routes.ts          # Express router, mount middleware + validators
├── <feature>.controller.ts      # HTTP layer, extracts inputs, calls service
├── <feature>.service.ts         # domain logic, transactions, event emits
├── <feature>.repository.ts      # Mongoose calls, returns lean or hydrated docs
├── <feature>.schemas.ts         # Zod schemas + inferred types
├── <feature>.events.ts          # (optional) socket event constants
├── <feature>.spec.ts            # unit tests alongside service
└── <feature>.socket.ts          # (optional) socket handlers for this feature
```

---

## API response shaping

- Always return the envelope.
- Never return Mongoose docs directly. Use DTO mappers.
- Paginated responses use cursor pagination:
  ```json
  { "success": true, "data": { "items": [...], "nextCursor": "..." } }
  ```
- Cursors are opaque base64-encoded. Server decodes.

---

## Socket.IO

- All events listed in `docs/ARCHITECTURE.md` §7.
- When adding a new event, add a constant in `src/shared/sockets/events.ts` and update the doc.
- Client and server must agree on the event payload shape. Define it in Zod or TS in a shared types file.
- Never emit sensitive data in a socket event. Emit IDs, let clients fetch via HTTP.

---

## Do not

- Do not hard-code IDs, rates, or configurable values. Put them in `app_config`.
- Do not call Mongoose directly in controllers.
- Do not `await` inside a loop when `Promise.all` works.
- Do not swallow errors. Log and rethrow, or convert to an `AppError`.
- Do not add dependencies without justification.
- Do not introduce new ESLint warnings.
- Do not commit secrets. `.env` is gitignored. Use `.env.example` for shape.
- Do not push to main directly. PR required.

---

## Layered defenses

Not every abuse vector deserves a server-side enforcement. Some are cheap enough at the attacker's side that layering a client-only control plus downstream fraud analytics is the correct trade. When deciding whether to add a server-side check, compute the per-incident and per-account cost, then compare against the enforcement cost.

Worked example — post-completion 5-second timer:

- **Attacker cost:** SMS OTP is ₹0.18/account (MSG91 bulk India rate). A fresh account starts with 3 coins and can earn at most ~5 coins/day from post-completion before running out of fresh posts. So the per-account daily exploit ceiling is ~₹0.05 of ad-equivalent reward, against ₹0.18 to create the account. The exploit is not self-funding.
- **Server enforcement cost:** A Redis-backed "post opened at" timer adds ~100 ms latency to every `POST /posts/:id/complete`, a new Redis key per view, and a new code path to maintain.
- **Decision:** Client-side-only 5-second timer (UI blocks the complete button for 5 s). The real defense is Phase 7 anti-fraud: device-fingerprint + IP clustering catches multi-account farming, which is where the actual loss scales.

Rule of thumb: if per-account exploit reward < per-account creation cost, prefer a lightweight client control + downstream analytics. Reach for a server-side check only when the exploit is self-funding at scale, or when the write being protected is irreversible (money, prize allocation, vote cast).

---

## Deferred implementations

Some collaborators are needed to _shape_ a service's API (so callers compile, tests run, transactions stay well-factored) but the real implementation belongs in a later phase. Pattern: **interface first, stub in place, real impl behind a later phase swap.**

- Declare the interface in `src/shared/<area>/<Name>.ts`.
- Ship a `Noop<Name>` or `<Name>Stub` that satisfies the interface with the cheapest possible behavior (returns `undefined`, logs nothing, emits nothing).
- Register the stub at the awilix composition root so callers depend on the interface, not the stub class.
- When the real phase lands, swap the registration — no caller changes.

Examples in-tree:

- `OtpServiceStub` (Phase 2) — satisfies the `OtpService` interface via DevConsole until MSG91 wiring lands.
- `NoopCoinEventEmitter` (Phase 3) — satisfies `CoinEventEmitter` for coin-balance change notifications; Phase 7 swaps in the real Socket.IO emitter.

Rule: if a service needs a collaborator whose real implementation is a phase or two out, do not inline-TODO it and do not skip the seam. Add the interface now so the eventual swap is one line in the container.
