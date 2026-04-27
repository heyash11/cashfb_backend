import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { MODELS } from '../models/index.js';
import type { SubscriptionAttrs } from '../models/Subscription.model.js';
import type { SubscriptionPaymentAttrs } from '../models/SubscriptionPayment.model.js';
import type { UserAttrs } from '../models/User.model.js';
import { CounterRepository } from '../repositories/Counter.repository.js';
import { LogOnlyEmailSender, type EmailSender } from './email-sender.js';
import { InvoiceService } from './invoice.service.js';
import { InMemoryObjectStore } from './object-store.js';
import type { MerchantProfile } from './pdf-renderer.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

const MH_MERCHANT: MerchantProfile = {
  legalName: 'CashFB Test Pvt Ltd',
  gstin: '27AAAAA0000A1Z5',
  stateCode: 'IN-MH',
  addressLine1: 'Test Address',
  pin: '400001',
};

function mkPayment(overrides: Partial<SubscriptionPaymentAttrs> = {}): SubscriptionPaymentAttrs {
  return {
    _id: new Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
    subscriptionId: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    razorpayPaymentId: `pay_${new Types.ObjectId().toHexString().slice(0, 8)}`,
    amount: 5900,
    sacCode: '998439',
    status: 'CAPTURED',
    ...overrides,
  };
}

function mkUser(overrides: Partial<UserAttrs> = {}): UserAttrs {
  return {
    _id: new Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
    phone: '+919876543210',
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    coinBalance: 0,
    totalCoinsEarned: 0,
    totalVotesCast: 0,
    signupBonusGranted: true,
    tokenVersion: 1,
    geoBlocked: false,
    ageVerified: true,
    kyc: { status: 'NONE' },
    blocked: { isBlocked: false },
    subscriptions: [],
    ...overrides,
  };
}

function mkSub(tier: SubscriptionAttrs['tier'] = 'PRO'): SubscriptionAttrs {
  return {
    _id: new Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: new Types.ObjectId(),
    tier,
    razorpaySubscriptionId: `sub_${new Types.ObjectId().toHexString().slice(0, 8)}`,
    razorpayPlanId: `plan_test_${tier}`,
    status: 'ACTIVE',
    billingCycle: 'MONTHLY',
    paidCount: 1,
    autoRenew: true,
  };
}

function mkSvc(overrides: Partial<ConstructorParameters<typeof InvoiceService>[0]> = {}) {
  const store = new InMemoryObjectStore();
  const email: EmailSender = new LogOnlyEmailSender();
  const svc = new InvoiceService({
    objectStore: store,
    emailSender: email,
    merchant: MH_MERCHANT,
    clock: () => new Date('2026-04-23T12:00:00Z'),
    ...overrides,
  });
  return { svc, store };
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

describe('InvoiceService.generateInvoice — intra-state', () => {
  it('merchant IN-MH + user IN-MH → CGST + SGST split, IGST = 0', async () => {
    const { svc } = mkSvc();
    const res = await svc.generateInvoice({
      payment: mkPayment({ amount: 11800 }),
      user: mkUser({ declaredState: 'IN-MH' }),
      subscription: mkSub('PRO_MAX'),
    });
    expect(res.base).toBe(10000);
    expect(res.gst).toBe(1800);
    expect(res.cgst).toBe(900);
    expect(res.sgst).toBe(900);
    expect(res.igst).toBe(0);
  });
});

describe('InvoiceService.generateInvoice — inter-state', () => {
  it('merchant IN-MH + user IN-KA → IGST carries full GST, CGST/SGST = 0', async () => {
    const { svc } = mkSvc();
    const res = await svc.generateInvoice({
      payment: mkPayment({ amount: 5900 }),
      user: mkUser({ declaredState: 'IN-KA' }),
      subscription: mkSub('PRO'),
    });
    expect(res.base).toBe(5000);
    expect(res.gst).toBe(900);
    expect(res.cgst).toBe(0);
    expect(res.sgst).toBe(0);
    expect(res.igst).toBe(900);
  });
});

describe('InvoiceService.generateInvoice — invoice numbering', () => {
  it('sequential per FY: CF/<FY>/000001, 000002, 000003 on back-to-back calls', async () => {
    const { svc } = mkSvc();
    const user = mkUser();
    const sub = mkSub();

    const a = await svc.generateInvoice({ payment: mkPayment(), user, subscription: sub });
    const b = await svc.generateInvoice({ payment: mkPayment(), user, subscription: sub });
    const c = await svc.generateInvoice({ payment: mkPayment(), user, subscription: sub });

    expect(a.invoiceNumber).toBe('CF/2026-27/000001');
    expect(b.invoiceNumber).toBe('CF/2026-27/000002');
    expect(c.invoiceNumber).toBe('CF/2026-27/000003');
  });
});

describe('InvoiceService — PDF output', () => {
  it('uploads a non-empty PDF buffer with %PDF magic bytes to the object store', async () => {
    const { svc, store } = mkSvc();
    const user = mkUser();
    const res = await svc.generateInvoice({
      payment: mkPayment(),
      user,
      subscription: mkSub(),
    });

    expect(res.pdfUrl).toMatch(/^memory:\/\/invoices\//);
    const key = res.pdfUrl.replace(/^memory:\/\//, '');
    const pdf = store.get(key);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf!.length).toBeGreaterThan(500);
    expect(pdf!.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });
});

describe('Counter race — 100 parallel invoice numbers', () => {
  it('Counter.incrementAndGet across 100 parallel calls produces 100 distinct sequential values', async () => {
    const counterRepo = new CounterRepository();
    const key = 'invoice:2026-27';

    const values = await Promise.all(
      Array.from({ length: 100 }, () => counterRepo.incrementAndGet(key)),
    );

    const set = new Set(values);
    expect(set.size).toBe(100);
    expect(Math.min(...values)).toBe(1);
    expect(Math.max(...values)).toBe(100);
    // Contiguous 1..100, no gaps.
    const sorted = [...values].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      expect(sorted[i]).toBe(i + 1);
    }
  }, 30_000);
});

describe('InvoiceService — email delivery', () => {
  it('sends the invoice email with attachment when user has an email', async () => {
    const sendSpy = vi.fn<EmailSender['send']>(async () => undefined);
    const { svc } = mkSvc({ emailSender: { send: sendSpy } });

    await svc.generateInvoice({
      payment: mkPayment(),
      user: mkUser({ email: 'alice@example.com' }),
      subscription: mkSub(),
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]?.[0];
    expect(call?.to).toBe('alice@example.com');
    expect(call?.subject).toMatch(/^CashFB invoice CF\/2026-27\/\d{6}$/);
    expect(call?.attachments).toHaveLength(1);
    expect(call?.attachments?.[0]?.contentType).toBe('application/pdf');
    expect(call?.attachments?.[0]?.content.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('does not attempt email when user has no email address', async () => {
    const sendSpy = vi.fn<EmailSender['send']>(async () => undefined);
    const { svc } = mkSvc({ emailSender: { send: sendSpy } });

    await svc.generateInvoice({
      payment: mkPayment(),
      user: mkUser(), // no email set
      subscription: mkSub(),
    });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('invoice still returns successfully when email delivery throws (best-effort)', async () => {
    const sendSpy = vi
      .fn<EmailSender['send']>()
      .mockRejectedValueOnce(new Error('SES unreachable'));
    const { svc, store } = mkSvc({ emailSender: { send: sendSpy } });

    const res = await svc.generateInvoice({
      payment: mkPayment(),
      user: mkUser({ email: 'alice@example.com' }),
      subscription: mkSub(),
    });

    expect(res.invoiceNumber).toMatch(/^CF\/2026-27\//);
    // PDF still in object store.
    const key = res.pdfUrl.replace(/^memory:\/\//, '');
    expect(store.get(key)).toBeInstanceOf(Buffer);
  });
});
