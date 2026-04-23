import { z } from 'zod';

export const CMS_KEYS = ['TERMS', 'HOW_DISTRIBUTE', 'FAQ', 'PRIVACY', 'GRIEVANCE'] as const;
export const CmsKeySchema = z.enum(CMS_KEYS);
export type CmsKey = z.infer<typeof CmsKeySchema>;

export const AdminCmsUpsertBodySchema = z
  .object({
    html: z.string().max(200_000).optional(),
  })
  .strict();

export type AdminCmsUpsertBody = z.infer<typeof AdminCmsUpsertBodySchema>;
