import { z } from 'zod';

/**
 * `target` is intentionally an opaque string — product decision
 * deferred per Phase 3 ambiguity #6. Trim leading/trailing whitespace,
 * require at least one non-whitespace char, cap at 100 to match the
 * Vote schema's storage shape.
 */
export const CastVoteBodySchema = z
  .object({
    target: z.string().trim().min(1).max(100),
  })
  .strict();

export type CastVoteBody = z.infer<typeof CastVoteBodySchema>;
