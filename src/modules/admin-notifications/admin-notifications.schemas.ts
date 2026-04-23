import { z } from 'zod';

const ObjectIdHex = z.string().regex(/^[a-f0-9]{24}$/i, '24-char hex ObjectId');
const TierSchema = z.enum(['PUBLIC', 'PRO', 'PRO_MAX']);

const AllTargetSchema = z.object({ mode: z.literal('all') }).strict();
const TierTargetSchema = z
  .object({
    mode: z.literal('tier'),
    tier: TierSchema,
  })
  .strict();
const UserTargetSchema = z
  .object({
    mode: z.literal('user'),
    userId: ObjectIdHex,
  })
  .strict();

export const AdminBroadcastBodySchema = z
  .object({
    target: z.discriminatedUnion('mode', [AllTargetSchema, TierTargetSchema, UserTargetSchema]),
    title: z.string().max(200).optional(),
    body: z.string().max(2000).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((d) => d.title !== undefined || d.body !== undefined, {
    message: 'broadcast must include at least one of title or body',
    path: ['body'],
  });

export type AdminBroadcastBody = z.infer<typeof AdminBroadcastBodySchema>;
