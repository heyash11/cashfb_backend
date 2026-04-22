# CashFB Backend

Node.js + TypeScript + MongoDB + Redis backend for CashFB, an Android-first ad-funded prize app for India.

> Consumer app in Flutter, admin panel in Flutter Web, this backend on AWS Mumbai. Users earn coins by watching ads, vote once a day to grow a prize pool, and race for pre-purchased Google Play gift codes. 100% ad-funded with optional Pro / Pro Max subscriptions (5x / 10x winnings multiplier).

---

## Quick start

```bash
# 1. Install deps
pnpm install

# 2. Copy env and fill in test credentials
cp .env.example .env

# 3. Bring up Mongo + Redis locally
docker compose -f docker-compose.dev.yml up -d

# 4. Seed default app config + SUPER_ADMIN user
pnpm seed

# 5. Create Razorpay test plans (one-time per environment)
pnpm migrate:plans

# 6. Run API and worker side by side
pnpm dev           # :4000
pnpm dev:worker    # in another terminal
```

Health check: `curl localhost:4000/health`.

---

## Documentation

All detailed docs live in `docs/`. Start with `CLAUDE.md` if you're using Claude Code, or the table below:

| File                     | When to read                             |
| ------------------------ | ---------------------------------------- |
| `CLAUDE.md`              | Entry point for Claude Code. Read first. |
| `docs/ARCHITECTURE.md`   | Canonical technical reference            |
| `docs/BUILD_PLAN.md`     | Phase-by-phase execution plan            |
| `docs/DATA_MODEL.md`     | All 26 Mongoose schemas                  |
| `docs/API.md`            | REST endpoint catalogue                  |
| `docs/PAYMENTS.md`       | Razorpay integration + GST invoicing     |
| `docs/SECURITY.md`       | Auth, encryption, RBAC, compliance       |
| `docs/DEPLOYMENT.md`     | AWS topology, CI/CD, monitoring          |
| `docs/CONVENTIONS.md`    | Code style and patterns                  |
| `docs/OPEN_DECISIONS.md` | 13 items pending owner sign-off          |
| `docs/GLOSSARY.md`       | Domain vocabulary                        |

---

## Tech stack

Node.js 22 LTS · TypeScript 5.6 (strict ESM) · Express 5 · MongoDB 7 + Mongoose 8 · Redis 7 · Socket.IO 4.7 + Redis adapter · BullMQ 5 · Razorpay · Zod · awilix · pino · Vitest 3.2.4 · AWS ECS Fargate ap-south-1 · Atlas via PrivateLink.

---

## Commands

```bash
pnpm dev              # API server with watch mode
pnpm dev:worker       # BullMQ worker with watch mode
pnpm build            # TypeScript compile
pnpm start            # Run compiled API server
pnpm start:worker     # Run compiled worker
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint
pnpm format           # Prettier
pnpm test             # Vitest
pnpm test:watch       # Vitest watch mode
pnpm test:coverage    # Coverage report
pnpm seed             # Seed app_config + SUPER_ADMIN
pnpm migrate:plans    # Create Razorpay plans
```

---

## Environments

| Env        | URL                              | Branch |
| ---------- | -------------------------------- | ------ |
| Local      | `http://localhost:4000`          | any    |
| Staging    | `https://staging-api.cashfb.com` | `main` |
| Production | `https://api.cashfb.com`         | `prod` |

Deploys are automated via GitHub Actions. See `docs/DEPLOYMENT.md`.

---

## Contributing

- Conventional commits (`feat(auth): ...`, `fix(votes): ...`).
- Every PR runs typecheck + lint + test.
- Update the relevant doc in `docs/` if you change a public contract.
- Any change touching money, votes, or sensitive data requires a review from the project lead.

See `docs/CONVENTIONS.md` for full guidelines.

---

## Project lead

**Ashutosh "Ashhu" Patil** · Senior Flutter + Node.js developer · Mumbai
patilashu819@gmail.com · +91 93738 31426
[linkedin.com/in/ashutoshpatil31](https://linkedin.com/in/ashutoshpatil31)

---

## License

Proprietary. All rights reserved.
