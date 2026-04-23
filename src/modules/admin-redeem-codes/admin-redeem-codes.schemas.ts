/**
 * Re-export the canonical admin schemas owned by the redeem-codes
 * domain. Chunk 2 doesn't add new shapes — it mounts HTTP around the
 * existing Phase 4 service boundary.
 */
export {
  AdminListCodesQuerySchema,
  AdminPublishBatchBodySchema,
  AdminUploadBatchMetaSchema,
  AdminVoidCodeBodySchema,
  type AdminListCodesQuery,
  type AdminPublishBatchBody,
  type AdminUploadBatchMeta,
  type AdminVoidCodeBody,
} from '../redeem-codes/redeem-codes.schemas.js';
