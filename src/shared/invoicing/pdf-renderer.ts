import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface MerchantProfile {
  legalName: string;
  gstin: string;
  stateCode: string; // ISO 3166-2:IN
  addressLine1: string;
  pin: string;
}

export interface InvoiceLine {
  description: string;
  sacCode: string;
  base: number; // paise
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface RenderInvoiceInput {
  merchant: MerchantProfile;
  customer: {
    name: string;
    phone: string;
    stateCode: string; // place of supply
    gstin?: string;
  };
  invoiceNumber: string;
  invoiceDate: Date;
  line: InvoiceLine;
}

function rupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

/**
 * Minimal GST tax invoice PDF. Single page, single line item, built
 * via pdf-lib for zero external processes or native deps. The layout
 * is deliberately plain: the goal is compliance (all fields per GST
 * Act s.31 + PAYMENTS.md §6), not visual polish — the admin panel can
 * ship a prettier template later.
 */
export async function renderInvoicePdf(input: RenderInvoiceInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);

  const draw = (text: string, x: number, y: number, size = 10, useBold = false): void => {
    page.drawText(text, { x, y, size, font: useBold ? bold : font, color: black });
  };

  // Header
  draw('TAX INVOICE', 220, 800, 16, true);
  draw(`Invoice No: ${input.invoiceNumber}`, 40, 770, 10, true);
  draw(`Date: ${input.invoiceDate.toISOString().slice(0, 10)}`, 400, 770);

  // Merchant block
  draw('From:', 40, 740, 10, true);
  draw(input.merchant.legalName, 40, 725);
  draw(input.merchant.addressLine1, 40, 710);
  draw(`PIN: ${input.merchant.pin}   State: ${input.merchant.stateCode}`, 40, 695);
  draw(`GSTIN: ${input.merchant.gstin}`, 40, 680);

  // Customer block
  draw('To:', 320, 740, 10, true);
  draw(input.customer.name || '(customer)', 320, 725);
  draw(`Phone: ${input.customer.phone}`, 320, 710);
  draw(`Place of Supply: ${input.customer.stateCode}`, 320, 695);
  if (input.customer.gstin) draw(`GSTIN: ${input.customer.gstin}`, 320, 680);

  // Line item table
  let y = 640;
  draw('Description', 40, y, 10, true);
  draw('SAC', 260, y, 10, true);
  draw('Base (INR)', 340, y, 10, true);
  draw('Tax (INR)', 440, y, 10, true);
  draw('Total (INR)', 510, y, 10, true);
  y -= 6;
  page.drawLine({
    start: { x: 40, y },
    end: { x: 555, y },
    thickness: 0.5,
    color: black,
  });
  y -= 14;
  draw(input.line.description, 40, y);
  draw(input.line.sacCode, 260, y);
  draw(rupees(input.line.base), 340, y);
  const taxTotal = input.line.cgst + input.line.sgst + input.line.igst;
  draw(rupees(taxTotal), 440, y);
  draw(rupees(input.line.total), 510, y);

  // Tax breakdown
  y -= 40;
  draw('Tax Breakdown', 40, y, 10, true);
  y -= 16;
  if (input.line.igst > 0) {
    draw(`IGST (18%): INR ${rupees(input.line.igst)}`, 40, y);
  } else {
    draw(`CGST (9%): INR ${rupees(input.line.cgst)}`, 40, y);
    draw(`SGST (9%): INR ${rupees(input.line.sgst)}`, 260, y);
  }

  // Totals
  y -= 32;
  draw(`Grand Total: INR ${rupees(input.line.total)}`, 40, y, 12, true);

  // Footer
  draw('This is a computer-generated invoice. No signature required.', 40, 60, 9);

  return Buffer.from(await doc.save());
}
