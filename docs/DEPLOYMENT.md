# DEPLOYMENT.md

AWS deployment guide for CashFB. Region: **ap-south-1 (Mumbai)**. India-only user base, data residency matters for DPDP Act.

---

## 1. Topology

```
India clients
   |
CloudFront (Price Class 200)
   |  (forwards cookies on /socket.io/*, /api/*)
   |
ALB (HTTPS, 2 AZ, idle 300s, lb_cookie sticky, dereg 120s)
   |
ECS Fargate api-svc (3 to 16 tasks, 1 or 2 vCPU, 2 or 4 GB)
ECS Fargate worker-svc (1 to 4 tasks, no ALB target)
   |
ElastiCache Redis 7 (Multi-AZ)
   |
MongoDB Atlas (ap-south-1) via PrivateLink
S3 uploads bucket + CloudFront OAC
SES ap-south-1 (transactional email)
FCM (push) called from workers with firebase-admin
Secrets Manager (rotating) + SSM Parameter Store (static)
CloudWatch Logs (14-day hot, then S3 Glacier IR)
Sentry (external SaaS)
```

Two services from one Docker image:

- `api-svc` runs `src/server.ts`. Fronted by ALB.
- `worker-svc` runs `src/worker.ts`. No public endpoint.

Both connect to the same Mongo and Redis, load the same env.

---

## 2. Why sticky sessions on ALB

Socket.IO allows both WebSocket and polling transports. Indian mobile networks (Jio, Airtel CGNAT) sometimes drop WS upgrades, forcing polling. Polling needs sticky routing, because the handshake and the subsequent poll must hit the same ECS task. The Redis adapter solves cross-task broadcasting but does not solve session stickiness.

Without stickiness: clients see `HTTP 400 "Session ID unknown"` after the handshake.

Config: `lb_cookie` stickiness, duration 3600s, deregistration delay 120s.

---

## 3. Sizing and cost (April 2026, ap-south-1, ₹93/USD)

### Launch tier. 10,000 DAU

| Line item                   | USD/mo       |
| --------------------------- | ------------ |
| Fargate 3 x (1 vCPU + 2 GB) | $124         |
| ALB                         | $29          |
| Atlas M20 + PITR            | $164         |
| ElastiCache t4g.small x 2   | $50          |
| NAT GW                      | $44          |
| CloudFront + S3 + SES       | $37          |
| CloudWatch + alarms         | $10          |
| Buffer (12%)                | $65          |
| **Total**                   | **~$523**    |
| **INR**                     | **~₹48,600** |

### Scale tier. 100,000 DAU

| Line item                                          | USD/mo         |
| -------------------------------------------------- | -------------- |
| Fargate 8 baseline + 2 autoscale x (2 vCPU + 4 GB) | $829           |
| ALB                                                | $76            |
| Atlas M30 + PITR                                   | $430           |
| ElastiCache m7g.large x 2                          | $272           |
| NAT GW x 2 (HA)                                    | $110           |
| CloudFront + S3 + SES                              | $389           |
| CloudWatch                                         | $91            |
| Buffer (13%)                                       | $299           |
| **Total**                                          | **~$2,496**    |
| **INR**                                            | **~₹2,32,000** |

1-year Compute Savings Plan reduces compute and NAT-attached items by ~20% once usage stabilises.

### Excluded

- SMS OTP: ~₹0.18 per OTP via MSG91 (DLT). 10k DAU x 2 OTPs/mo is ~₹3,600/mo. 100k DAU is ~₹36,000/mo.
- Razorpay: 2% on subscriptions + 2% on donations.
- Gift cards: 1 to 3% discount on face value from authorised B2B resellers.
- Sentry and ancillary SaaS: ~$50 to $150/mo.

---

## 4. Atlas connectivity

**Use AWS PrivateLink**, not public allowlist or VPC peering.

- Private endpoint creates an interface VPC endpoint in your VPC.
- Traffic does not traverse the public internet.
- No egress fees from NAT Gateway to Atlas.
- Stable under Fargate IP churn (no whitelist thrash).
- DPDP posture strengthened: no data crosses the public internet between ECS and Atlas.

Cost: ~$20/mo per endpoint. Worth it.

---

## 5. CI/CD

### GitHub Actions workflow

`.github/workflows/deploy.yml`:

1. OIDC assume role into AWS. No long-lived access keys.
2. Build Docker image, tag with commit SHA.
3. Push to ECR.
4. Render ECS task definition from template (`.aws/task-def.json`).
5. `aws ecs update-service --force-new-deployment` with deployment circuit breaker enabled.
6. On failure, auto-rollback to previous task definition.

### Environments

- `main` branch to staging (auto on merge).
- `prod` branch to production (fast-forward-only from `main`, manual approval gate).

### Graceful shutdown

```ts
// src/server.ts
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, draining');
  io.close(); // stop accepting new socket conns
  server.close(() => logger.info('HTTP closed'));
  await queue.close(); // if worker, close BullMQ
  process.exit(0);
});
```

Stop timeout in task definition: 120s. ALB deregistration delay: 120s.

---

## 6. Secrets

### AWS Secrets Manager (rotating)

- `cashfb/mongo/uri`
- `cashfb/razorpay/key-id`
- `cashfb/razorpay/key-secret`
- `cashfb/razorpay/webhook-secret`
- `cashfb/jwt/private-key-pem`
- `cashfb/jwt/public-key-pem`
- `cashfb/msg91/auth-key`

### SSM Parameter Store SecureString (static)

- `/cashfb/prod/sentry-dsn`
- `/cashfb/prod/fcm-service-account-json` (base64)
- `/cashfb/prod/merchant-gstin`
- `/cashfb/prod/merchant-legal-name`

### Task definition inject

```json
"secrets": [
  { "name": "MONGO_URI",               "valueFrom": "arn:aws:secretsmanager:...:secret:cashfb/mongo/uri" },
  { "name": "RAZORPAY_KEY_SECRET",     "valueFrom": "arn:aws:secretsmanager:...:secret:cashfb/razorpay/key-secret" },
  { "name": "SENTRY_DSN",              "valueFrom": "arn:aws:ssm:...:parameter/cashfb/prod/sentry-dsn" }
]
```

---

## 7. Monitoring and alarms

### CloudWatch alarms

| Alarm                  | Threshold            | Severity              |
| ---------------------- | -------------------- | --------------------- |
| ALB 5xx                | > 20 in 5 min        | P1                    |
| ALB target p95 latency | > 1.5 s              | P2                    |
| ECS CPU                | > 80% 10 min         | P2                    |
| ECS memory             | > 85% 10 min         | P2                    |
| ElastiCache Redis CPU  | > 75% 10 min         | P2                    |
| ElastiCache evictions  | > 0                  | P3                    |
| Atlas connections      | > 80% of pool        | P2                    |
| Atlas replication lag  | > 5 s                | P1                    |
| NAT egress             | > 80% expected daily | P2 (bill-shock guard) |
| Sentry error rate      | > baseline x 3       | P2                    |

Alarms deliver to PagerDuty via SNS.

### Sentry

- Init via `node --import ./dist/instrument.js dist/server.js`.
- Release tracking: CI uploads source maps with commit SHA.
- Performance monitoring sampled at 10% in prod.

### Logging

- `pino` JSON to stdout.
- ECS log driver pushes to CloudWatch Logs (14-day retention).
- Export to S3 Glacier Instant Retrieval for long-term archive.
- Never log PII in plaintext. Redaction list enforced via pino config.

---

## 8. Backups and DR

- **Atlas continuous backup** (PITR) with 72-hour window. Mandatory.
- **S3 versioning** on uploads + invoices buckets.
- **Redis** daily snapshot, 7-day retention (for BullMQ job durability).

| Metric              | Target |
| ------------------- | ------ |
| RPO (Mongo)         | 1 min  |
| RPO (Redis)         | 5 min  |
| RTO (stateless app) | 5 min  |
| RTO (Mongo restore) | 30 min |

Multi-region DR (warm standby in ap-southeast-1) is **not** justified for India-only MVP. Document and accept regional-outage risk.

---

## 9. Network

### VPC

- 2 AZ (ap-south-1a, ap-south-1b).
- Public subnets: ALB, NAT Gateway.
- Private subnets: ECS Fargate tasks, ElastiCache, Atlas PrivateLink endpoint.
- Outbound: via NAT. No public IPs on tasks.

### Security groups

- ALB SG: 443 from `0.0.0.0/0`.
- ECS SG: inbound from ALB only on container port.
- ElastiCache SG: inbound from ECS SG only on 6379.
- Atlas endpoint SG: inbound from ECS SG only.

---

## 10. Local development

```bash
cp .env.example .env
# Fill in test Razorpay keys, MSG91 dev key, etc.

docker compose -f docker-compose.dev.yml up -d
# Mongo replset rs0 on 27017, Redis on 6379

pnpm install
pnpm seed                 # creates app_config + SUPER_ADMIN
pnpm migrate:plans        # creates Razorpay test plans
pnpm dev                  # api-svc on :4000
pnpm dev:worker           # worker-svc alongside
```

Webhooks in dev: use `ngrok http 4000`, paste HTTPS URL into Razorpay test dashboard webhook config.

---

## 11. Release checklist

Before a prod deploy:

- [ ] All CI checks green on `main`.
- [ ] Manual smoke test of new feature on staging.
- [ ] DB migration (if any) rehearsed on staging copy.
- [ ] `pnpm migrate:plans` rerun if new Razorpay plan was added.
- [ ] Secrets Manager values in place for any new env var.
- [ ] Runbook updated if new alarm or failure mode introduced.
- [ ] Feature flags set correctly for prod.

Deploy window: avoid Friday afternoons IST. Prefer Tue to Thu mornings for maximum on-call availability.
