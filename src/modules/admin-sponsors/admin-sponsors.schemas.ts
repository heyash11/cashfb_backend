import { z } from 'zod';

const SponsorStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'EXPIRED']);

export const AdminSponsorsListQuerySchema = z
  .object({
    slot: z.coerce.number().int().min(1).max(3).optional(),
    status: SponsorStatusSchema.optional(),
  })
  .strict();

export const AdminSponsorCreateBodySchema = z
  .object({
    slot: z.number().int().min(1).max(3),
    imageUrl: z.string().url().max(500),
    linkUrl: z.string().url().max(500).optional(),
    title: z.string().max(200).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional(),
    status: SponsorStatusSchema.optional(),
  })
  .strict();

export const AdminSponsorUpdateBodySchema = z
  .object({
    slot: z.number().int().min(1).max(3).optional(),
    imageUrl: z.string().url().max(500).optional(),
    linkUrl: z.string().url().max(500).optional(),
    title: z.string().max(200).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional(),
    status: SponsorStatusSchema.optional(),
  })
  .strict();

export type AdminSponsorsListQuery = z.infer<typeof AdminSponsorsListQuerySchema>;
export type AdminSponsorCreateBody = z.infer<typeof AdminSponsorCreateBodySchema>;
export type AdminSponsorUpdateBody = z.infer<typeof AdminSponsorUpdateBodySchema>;
