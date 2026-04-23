import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { Types } from 'mongoose';
import type Razorpay from 'razorpay';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { seedAdminSession } from '../../../test/testing/admin-session-seed.js';
import { AppError } from '../../shared/errors/AppError.js';
import { AuditLogModel } from '../../shared/models/AuditLog.model.js';
import { MODELS } from '../../shared/models/index.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { SubscriptionPaymentModel } from '../../shared/models/SubscriptionPayment.model.js';
import { RefundService } from '../refunds/refunds.service.js';
import { createAdminRefundsRouter } from './admin-refunds.routes.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

/**
 * The live RefundService ctor pulls a real Razorpay client via
 * `getRazorpayClient()`. createApp() doesn't accept a service
 * override, so this spec wires its own Express app with a
 * fake-Razorpay-backed RefundService and re-uses the admin-refunds
 * router plus the same error-handler shape app.ts ships.
 */
function mkFakeRzp(refundId = 'rfnd_smoke_1'): Razorpay {
  const refundSpy = vi.fn(async (_id: string, _params: Record<string, unknown>) => ({
    id: refundId,
    payment_id: _id,
    amount: (_params['amount'] as number | undefined) ?? 5900,
    status: 'processed',
  }));
  const cancelSpy = vi.fn(async (_id: string, _flag?: boolean | number) => ({
    id: _id,
    status: 'cancelled',
  }));
  return {
    payments: { refund: refundSpy },
    subscriptions: { cancel: cancelSpy },
  } as unknown as Razorpay;
}

function makeAppWithFakeRazorpay(rzp: Razorpay): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const service = new RefundService({ razorpay: rzp });
  app.use('/api/v1/admin/refunds', createAdminRefundsRouter(service));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      res.status(err.httpStatus).json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
  });
  return app;
}

async function seedPayment(): Promise<Types.ObjectId> {
  const userId = new Types.ObjectId();
  const sub = await SubscriptionModel.create({
    userId,
    tier: 'PRO',
    razorpaySubscriptionId: `sub_${new Types.ObjectId().toHexString()}`,
    razorpayPlanId: 'plan_PRO',
    status: 'ACTIVE',
    billingCycle: 'MONTHLY',
    paidCount: 1,
    autoRenew: true,
  });
  const payment = await SubscriptionPaymentModel.create({
    subscriptionId: sub._id,
    userId,
    razorpayPaymentId: `pay_${new Types.ObjectId().toHexString()}`,
    amount: 5900,
    status: 'CAPTURED',
    capturedAt: new Date(),
  });
  return payment._id;
}

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('admin-refunds routes', () => {
  it('POST / initiates refund for PAYMENT_ADMIN and records audit row', async () => {
    const app = makeAppWithFakeRazorpay(mkFakeRzp('rfnd_ok_1'));
    const paymentId = await seedPayment();
    const seed = await seedAdminSession({ role: 'PAYMENT_ADMIN' });

    const res = await request(app)
      .post('/api/v1/admin/refunds')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ paymentId: paymentId.toHexString(), reason: 'customer request' });

    expect(res.status).toBe(200);
    expect(res.body.data.razorpayRefundId).toBe('rfnd_ok_1');

    const audit = await AuditLogModel.findOne({ action: 'REFUND_INITIATE' });
    expect(audit).toBeTruthy();
    expect(audit?.actorId.toHexString()).toBe(seed.adminId);
    expect(audit?.resource?.kind).toBe('SubscriptionPayment');
    expect((audit?.after as { razorpayRefundId?: string } | null)?.razorpayRefundId).toBe(
      'rfnd_ok_1',
    );
  });

  it('rejects 401 without session and 403 when SUPPORT_ADMIN attempts a refund', async () => {
    const app = makeAppWithFakeRazorpay(mkFakeRzp());
    const paymentId = await seedPayment();

    const noSession = await request(app)
      .post('/api/v1/admin/refunds')
      .send({ paymentId: paymentId.toHexString(), reason: 'test' });
    expect(noSession.status).toBe(401);

    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const wrongRole = await request(app)
      .post('/api/v1/admin/refunds')
      .set('Cookie', support.cookieHeader)
      .set(support.csrfHeaderName, support.csrfToken)
      .send({ paymentId: paymentId.toHexString(), reason: 'test' });
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.body.error.code).toBe('FORBIDDEN');
  });
});
