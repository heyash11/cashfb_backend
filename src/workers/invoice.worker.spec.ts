import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../test/testing/mongo.js';
import type { InvoiceService } from '../shared/invoicing/invoice.types.js';
import { MODELS } from '../shared/models/index.js';
import { SubscriptionModel } from '../shared/models/Subscription.model.js';
import { SubscriptionPaymentModel } from '../shared/models/SubscriptionPayment.model.js';
import { UserModel } from '../shared/models/User.model.js';
import { createInvoiceHandler } from './invoice.worker.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedFixtures() {
  const user = await UserModel.create({
    phone: '+919877654321',
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    email: 'test@example.com',
  });
  const sub = await SubscriptionModel.create({
    userId: user._id,
    tier: 'PRO',
    razorpaySubscriptionId: 'sub_test',
    razorpayPlanId: 'plan_test',
    status: 'ACTIVE',
    billingCycle: 'MONTHLY',
    paidCount: 1,
    autoRenew: true,
  });
  const payment = await SubscriptionPaymentModel.create({
    subscriptionId: sub._id,
    userId: user._id,
    razorpayPaymentId: `pay_${new Types.ObjectId().toHexString().slice(0, 8)}`,
    amount: 5900,
    sacCode: '998439',
    status: 'CAPTURED',
    capturedAt: new Date(),
  });
  return { user, sub, payment };
}

function fakeInvoiceService(
  result = {
    invoiceNumber: 'CF/2026-27/000001',
    pdfUrl: 'memory://invoices/test.pdf',
    base: 5000,
    gst: 900,
    cgst: 450,
    sgst: 450,
    igst: 0,
  },
): { service: InvoiceService; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn().mockResolvedValue(result);
  return { service: { generateInvoice: spy } as unknown as InvoiceService, spy };
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

describe('invoice worker handler', () => {
  it('happy path: generates invoice and populates the payment row with invoiceNumber + pdfUrl + GST breakdown', async () => {
    const { service, spy } = fakeInvoiceService();
    const handler = createInvoiceHandler({ invoiceService: service });
    const { payment } = await seedFixtures();

    const result = await handler({ paymentId: String(payment._id) });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      invoiceNumber: 'CF/2026-27/000001',
      pdfUrl: 'memory://invoices/test.pdf',
    });

    const after = await SubscriptionPaymentModel.findById(payment._id);
    expect(after?.invoiceNumber).toBe('CF/2026-27/000001');
    expect(after?.invoicePdfUrl).toBe('memory://invoices/test.pdf');
    expect(after?.baseAmount).toBe(5000);
    expect(after?.gstAmount).toBe(900);
    expect(after?.placeOfSupply).toBe('IN-MH');
  });

  it('idempotent: second invocation on a payment that already has an invoiceNumber no-ops without re-running the PDF pipeline', async () => {
    const { service, spy } = fakeInvoiceService();
    const handler = createInvoiceHandler({ invoiceService: service });
    const { payment } = await seedFixtures();

    await SubscriptionPaymentModel.updateOne(
      { _id: payment._id },
      {
        $set: {
          invoiceNumber: 'CF/2026-27/ALREADY-HERE',
          invoicePdfUrl: 'memory://invoices/already.pdf',
        },
      },
    );

    const result = await handler({ paymentId: String(payment._id) });

    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: 'ALREADY_GENERATED' });

    const after = await SubscriptionPaymentModel.findById(payment._id);
    expect(after?.invoiceNumber).toBe('CF/2026-27/ALREADY-HERE'); // unchanged
  });

  it('propagates InvoiceService errors so BullMQ records a failed attempt', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('KMS unreachable'));
    const handler = createInvoiceHandler({
      invoiceService: { generateInvoice: spy } as unknown as InvoiceService,
    });
    const { payment } = await seedFixtures();

    await expect(handler({ paymentId: String(payment._id) })).rejects.toThrow('KMS unreachable');
  });
});
