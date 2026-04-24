import type { Request, Response } from 'express';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { requireContext } from '../../shared/middleware/requestContext.js';
import type { AuthService } from './auth.service.js';
import type {
  LogoutBody,
  RefreshBody,
  RequestLoginOtpBody,
  RequestSignupOtpBody,
  VerifyLoginOtpBody,
  VerifySignupOtpBody,
} from './auth.schemas.js';

/**
 * HTTP edge. Pulls the already-populated `req.context` (see
 * requestContext middleware) and the Zod-parsed body, calls
 * AuthService, and renders the success envelope. Throws AppError via
 * the service; no try/catch here per CONVENTIONS.md §Express.
 */
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  requestSignupOtp = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as RequestSignupOtpBody;
    const ctx = requireContext(req);
    const data = await this.svc.requestSignupOtp({
      phone: body.phone,
      deviceId: body.deviceId,
      deviceFingerprint: body.deviceFingerprint,
      ipAddress: ctx.ipAddress,
    });
    res.json({ success: true, data });
  };

  verifySignupOtp = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as VerifySignupOtpBody;
    const ctx = requireContext(req);
    const data = await this.svc.verifySignupOtp({
      phone: body.phone,
      otp: body.otp,
      dob: body.dob,
      declaredState: body.declaredState,
      referralCode: body.referralCode,
      consentVersion: body.consentVersion,
      consentAcceptedAt: body.consentAcceptedAt,
      privacyPolicyVersion: body.privacyPolicyVersion,
      deviceId: body.deviceId,
      deviceFingerprint: body.deviceFingerprint,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      ...(body._devBypassOtp === true ? { _devBypassOtp: true as const } : {}),
    });
    res.json({ success: true, data });
  };

  requestLoginOtp = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as RequestLoginOtpBody;
    const ctx = requireContext(req);
    const data = await this.svc.requestLoginOtp({
      phone: body.phone,
      ipAddress: ctx.ipAddress,
    });
    res.json({ success: true, data });
  };

  verifyLoginOtp = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as VerifyLoginOtpBody;
    const ctx = requireContext(req);
    const data = await this.svc.verifyLoginOtp({
      phone: body.phone,
      otp: body.otp,
      deviceId: body.deviceId,
      deviceFingerprint: body.deviceFingerprint,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    res.json({ success: true, data });
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as RefreshBody;
    const ctx = requireContext(req);
    if (!ctx.deviceId) {
      // X-Device-Id is required to refresh. Zod validated the body;
      // the header is the binding dimension.
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'X-Device-Id header is required for refresh',
        },
      });
      return;
    }
    const data = await this.svc.refresh({
      refreshToken: body.refreshToken,
      deviceId: ctx.deviceId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    res.json({ success: true, data });
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as LogoutBody;
    const user = requireAuthedUser(req);
    await this.svc.logout({ refreshToken: body.refreshToken, userId: user.sub });
    res.json({ success: true, data: { revoked: true } });
  };

  logoutAll = async (req: Request, res: Response): Promise<void> => {
    const user = requireAuthedUser(req);
    const data = await this.svc.logoutAll({ userId: user.sub });
    res.json({ success: true, data });
  };
}
