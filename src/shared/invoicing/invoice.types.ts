import type { SubscriptionAttrs } from '../models/Subscription.model.js';
import type { SubscriptionPaymentAttrs } from '../models/SubscriptionPayment.model.js';
import type { UserAttrs } from '../models/User.model.js';

export interface GenerateInvoiceInput {
  payment: SubscriptionPaymentAttrs;
  user: UserAttrs;
  subscription: SubscriptionAttrs;
}

export interface GenerateInvoiceResult {
  invoiceNumber: string;
  pdfUrl: string;
  base: number;
  gst: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Interface-first stub-later seam per CONVENTIONS.md §Deferred
 * implementations. Phase 5 Chunk 2 injects `InvoiceServiceStub` so
 * the subscription-charged webhook handler runs end-to-end; Chunk 3
 * swaps in the real `InvoiceService` with GST math + PDF render +
 * S3 upload + SES delivery.
 */
export interface InvoiceService {
  generateInvoice(input: GenerateInvoiceInput): Promise<GenerateInvoiceResult>;
}
