import type {
  GenerateInvoiceInput,
  GenerateInvoiceResult,
  InvoiceService,
} from './invoice.types.js';

/**
 * Phase 5 Chunk 2 stub. Returns deterministic fake numbers so the
 * subscription.charged webhook handler can run and write the
 * invoiceNumber / invoicePdfUrl onto the payment row without the
 * full GST + PDF + S3 + SES pipeline.
 *
 * Chunk 3 deletes this file and replaces it with the real
 * `InvoiceService` that derives base/GST, renders a PDF, uploads to
 * S3, and emails via SES. Interface unchanged.
 */
export class InvoiceServiceStub implements InvoiceService {
  private counter = 0;

  async generateInvoice(input: GenerateInvoiceInput): Promise<GenerateInvoiceResult> {
    this.counter += 1;
    const seq = String(this.counter).padStart(4, '0');
    const total = input.payment.amount ?? 0;
    const base = Math.round((total * 100) / 118);
    const gst = total - base;
    return {
      invoiceNumber: `CF/2026-27/STUB-${seq}`,
      pdfUrl: `memory://invoices/${String(input.user._id)}/stub-${seq}.pdf`,
      base,
      gst,
      cgst: 0,
      sgst: 0,
      igst: gst,
    };
  }
}
