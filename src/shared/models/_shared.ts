/**
 * Shared subdocument types reused across multiple model files.
 *
 * Extract to `_shared.ts` only when the same shape appears on two or
 * more schemas; keep model-specific subdocs inline in the owning
 * `.model.ts` file so contributors don't have to cross-reference.
 */

export interface SocialLinks {
  youtube?: string;
  facebook?: string;
  instagram?: string;
}
