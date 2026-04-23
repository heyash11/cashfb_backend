import { Types } from 'mongoose';
import { logger } from '../config/logger.js';
import type { InvoiceJobPayload } from '../shared/jobs/enqueue.js';
import { InvoiceService } from '../shared/invoicing/invoice.service.js';
import type { InvoiceService as IInvoiceService } from '../shared/invoicing/invoice.types.js';
import { SubscriptionRepository } from '../shared/repositories/Subscription.repository.js';
import { SubscriptionPaymentRepository } from '../shared/repositories/SubscriptionPayment.repository.js';
import { UserRepository } from '../shared/repositories/User.repository.js';

export interface InvoiceHandlerDeps {
  invoiceService?: IInvoiceService;
  subPaymentRepo?: SubscriptionPaymentRepository;
  subRepo?: SubscriptionRepository;
  userRepo?: UserRepository;
}

export interface InvoiceHandlerResult {
  invoiceNumber: string;
  pdfUrl: string;
}

/**
 * Invoice-generation worker. Consumes the `invoice` queue; each job
 * carries `{paymentId}`. Handler loads the payment + user + sub,
 * runs the real InvoiceService (GST calc + PDF render + S3 upload +
 * SES email), then writes the invoice metadata onto the payment row.
 *
 * Idempotency: jobId = `invoice-<paymentId>` at the enqueue site
 * (BullMQ dedupes). Domain-level fallback: if a payment already has
 * an invoiceNumber, the handler no-ops without re-running the PDF
 * pipeline.
 */
export function createInvoiceHandler(
  deps: InvoiceHandlerDeps = {},
): (data: InvoiceJobPayload) => Promise<InvoiceHandlerResult | { skipped: 'ALREADY_GENERATED' }> {
  const invoiceService = deps.invoiceService ?? new InvoiceService();
  const subPaymentRepo = deps.subPaymentRepo ?? new SubscriptionPaymentRepository();
  const subRepo = deps.subRepo ?? new SubscriptionRepository();
  const userRepo = deps.userRepo ?? new UserRepository();

  return async (data: InvoiceJobPayload) => {
    const paymentId = new Types.ObjectId(data.paymentId);
    const payment = await subPaymentRepo.findById(paymentId);
    if (!payment) {
      throw new Error(`invoice worker: payment ${data.paymentId} not found`);
    }
    if (payment.invoiceNumber && payment.invoicePdfUrl) {
      logger.info(
        { paymentId: data.paymentId, invoiceNumber: payment.invoiceNumber },
        '[invoice-worker] already generated; skipping',
      );
      return { skipped: 'ALREADY_GENERATED' as const };
    }

    const subscription = await subRepo.findById(payment.subscriptionId);
    if (!subscription) {
      throw new Error(`invoice worker: subscription ${String(payment.subscriptionId)} not found`);
    }
    const user = await userRepo.findById(payment.userId);
    if (!user) {
      throw new Error(`invoice worker: user ${String(payment.userId)} not found`);
    }

    const res = await invoiceService.generateInvoice({ payment, user, subscription });
    await subPaymentRepo.updateOne(
      { _id: payment._id },
      {
        $set: {
          invoiceNumber: res.invoiceNumber,
          invoicePdfUrl: res.pdfUrl,
          baseAmount: res.base,
          gstAmount: res.gst,
          cgst: res.cgst,
          sgst: res.sgst,
          igst: res.igst,
          placeOfSupply: user.declaredState,
        },
      },
    );

    return { invoiceNumber: res.invoiceNumber, pdfUrl: res.pdfUrl };
  };
}
