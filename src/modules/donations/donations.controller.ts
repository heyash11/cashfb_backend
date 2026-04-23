import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type { SocialLinks } from '../../shared/models/_shared.js';
import type { DonationService } from './donations.service.js';
import {
  CreateDonationOrderBodySchema,
  TopDonorsQuerySchema,
  VerifyDonationBodySchema,
} from './donations.schemas.js';

function pickSocialLinks(
  raw:
    | {
        youtube?: string | undefined;
        facebook?: string | undefined;
        instagram?: string | undefined;
      }
    | undefined,
): SocialLinks | undefined {
  if (!raw) return undefined;
  const out: SocialLinks = {};
  if (raw.youtube !== undefined) out.youtube = raw.youtube;
  if (raw.facebook !== undefined) out.facebook = raw.facebook;
  if (raw.instagram !== undefined) out.instagram = raw.instagram;
  return out;
}

/**
 * HTTP edge for public donation endpoints. Donations are anonymous-
 * friendly (API.md §5 shows `P` auth only): we try to read the user
 * from the optional `req.user` claim set upstream but do not require
 * it.
 */
export class DonationsController {
  constructor(private readonly service: DonationService) {}

  createOrder = async (req: Request, res: Response): Promise<void> => {
    const body = CreateDonationOrderBodySchema.parse(req.body);
    const userSub = req.user?.sub;
    const socialLinks = pickSocialLinks(body.socialLinks);
    const result = await this.service.createOrder({
      userId: userSub ? new Types.ObjectId(userSub) : null,
      amountInRupees: body.amountInRupees,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.isAnonymous !== undefined ? { isAnonymous: body.isAnonymous } : {}),
      ...(socialLinks !== undefined ? { socialLinks } : {}),
      ...(body.message !== undefined ? { message: body.message } : {}),
      ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    });
    res.json({ success: true, data: result });
  };

  verify = async (req: Request, res: Response): Promise<void> => {
    const body = VerifyDonationBodySchema.parse(req.body);
    const result = await this.service.verify(body);
    res.json({ success: true, data: result });
  };

  getTopDonor = async (_req: Request, res: Response): Promise<void> => {
    const donor = await this.service.getTopDonor();
    res.json({ success: true, data: donor });
  };

  listTopDonors = async (req: Request, res: Response): Promise<void> => {
    const { limit } = TopDonorsQuerySchema.parse(req.query);
    const items = await this.service.listTopDonors(limit);
    res.json({ success: true, data: { items } });
  };
}
