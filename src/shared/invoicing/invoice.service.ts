import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { CounterRepository } from '../repositories/Counter.repository.js';
import { LogOnlyEmailSender, type EmailSender, SesEmailSender } from './email-sender.js';
import { currentFyIST, deriveBaseAndGst, splitGst } from './gst.js';
import type {
  GenerateInvoiceInput,
  GenerateInvoiceResult,
  InvoiceService as IInvoiceService,
} from './invoice.types.js';
import { InMemoryObjectStore, type ObjectStore, S3ObjectStore } from './object-store.js';
import { renderInvoicePdf, type MerchantProfile } from './pdf-renderer.js';

export interface InvoiceServiceDeps {
  counterRepo?: CounterRepository;
  objectStore?: ObjectStore;
  emailSender?: EmailSender;
  merchant?: MerchantProfile;
  clock?: () => Date;
}

function defaultMerchant(): MerchantProfile {
  return {
    legalName: env.MERCHANT_LEGAL_NAME ?? 'CashFB (dev placeholder)',
    gstin: env.MERCHANT_GSTIN ?? '27AAAAA0000A1Z5',
    stateCode: env.MERCHANT_STATE_CODE ?? 'IN-MH',
    addressLine1: env.MERCHANT_ADDRESS_LINE1 ?? '(dev placeholder)',
    pin: env.MERCHANT_PIN ?? '400001',
  };
}

function defaultObjectStore(): ObjectStore {
  if (env.S3_INVOICES_BUCKET && env.AWS_REGION) {
    return new S3ObjectStore({ region: env.AWS_REGION, bucket: env.S3_INVOICES_BUCKET });
  }
  return new InMemoryObjectStore();
}

function defaultEmailSender(): EmailSender {
  if (env.SES_FROM_EMAIL && env.AWS_REGION) {
    return new SesEmailSender({
      region: env.AWS_REGION,
      fromEmail: env.SES_FROM_EMAIL,
      ...(env.SES_REPLY_TO_EMAIL !== undefined ? { replyToEmail: env.SES_REPLY_TO_EMAIL } : {}),
    });
  }
  return new LogOnlyEmailSender();
}

/**
 * Real InvoiceService. Replaces `InvoiceServiceStub` from Chunk 2.
 * Flow:
 *   1. Derive base + GST from payment amount (18% GST rate baked
 *      into PAYMENTS.md §6).
 *   2. Split intra-state (CGST/SGST) vs inter-state (IGST) based on
 *      merchant state vs user.declaredState.
 *   3. Mint a sequential invoice number per FY via the Counter
 *      atomic `$inc`. Format: `CF/<FY>/<000001>`.
 *   4. Render a GST-compliant PDF (pdf-lib, in-process).
 *   5. Upload to S3 (prod) or InMemoryObjectStore (dev/test).
 *   6. Attempt email delivery. Failure here does not fail the
 *      invoice — the PDF is already persisted.
 */
export class InvoiceService implements IInvoiceService {
  private readonly counterRepo: CounterRepository;
  private readonly objectStore: ObjectStore;
  private readonly emailSender: EmailSender;
  private readonly merchant: MerchantProfile;
  private readonly clock: () => Date;

  constructor(deps: InvoiceServiceDeps = {}) {
    this.counterRepo = deps.counterRepo ?? new CounterRepository();
    this.objectStore = deps.objectStore ?? defaultObjectStore();
    this.emailSender = deps.emailSender ?? defaultEmailSender();
    this.merchant = deps.merchant ?? defaultMerchant();
    this.clock = deps.clock ?? (() => new Date());
  }

  async generateInvoice(input: GenerateInvoiceInput): Promise<GenerateInvoiceResult> {
    const total = input.payment.amount ?? 0;
    const { base, gst } = deriveBaseAndGst(total);

    const intraState = this.merchant.stateCode === input.user.declaredState;
    const { cgst, sgst, igst } = splitGst(gst, intraState);

    const now = this.clock();
    const fy = currentFyIST(now);
    const seq = await this.counterRepo.incrementAndGet(`invoice:${fy}`);
    const invoiceNumber = `CF/${fy}/${String(seq).padStart(6, '0')}`;

    const description =
      input.subscription.tier === 'PRO_MAX'
        ? 'CashFB Pro Max subscription, monthly'
        : 'CashFB Pro subscription, monthly';

    const pdf = await renderInvoicePdf({
      merchant: this.merchant,
      customer: {
        name: input.user.displayName ?? '(user)',
        phone: input.user.phone,
        stateCode: input.user.declaredState,
      },
      invoiceNumber,
      invoiceDate: now,
      line: {
        description,
        sacCode: '998439',
        base,
        cgst,
        sgst,
        igst,
        total,
      },
    });

    const objectKey = `invoices/${String(input.user._id)}/${invoiceNumber.replace(/\//g, '_')}.pdf`;
    const { url } = await this.objectStore.put(objectKey, pdf, 'application/pdf');

    // Email delivery is best-effort; do not fail the invoice if SES
    // is down or the from-domain isn't verified yet.
    if (input.user.email) {
      try {
        await this.emailSender.send({
          to: input.user.email,
          subject: `CashFB invoice ${invoiceNumber}`,
          bodyText: `Hi ${input.user.displayName ?? 'there'},\n\nYour GST invoice is attached.\n\nThanks,\nCashFB`,
          attachments: [
            {
              filename: `${invoiceNumber.replace(/\//g, '_')}.pdf`,
              contentType: 'application/pdf',
              content: pdf,
            },
          ],
        });
      } catch (err) {
        logger.warn(
          { err, invoiceNumber },
          '[invoice] email delivery failed; PDF already persisted to object store',
        );
      }
    }

    return { invoiceNumber, pdfUrl: url, base, gst, cgst, sgst, igst };
  }
}
