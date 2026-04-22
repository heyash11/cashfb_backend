import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import { InternalError } from '../../shared/errors/AppError.js';
import { RedisLockoutStore } from './lockout.store.js';
import { DevConsoleSender } from './otp.devconsole.js';
import { Msg91Sender } from './otp.msg91.js';
import { OtpServiceImpl } from './otp.service.js';
import type { OtpSender, OtpService } from './otp.types.js';

/**
 * Wire the concrete OtpService for prod / dev.
 *
 * Selection logic:
 *   OTP_SENDER=msg91       → Msg91Sender. Requires MSG91_AUTH_KEY + MSG91_TEMPLATE_ID.
 *   OTP_SENDER=dev-console → DevConsoleSender. Refuses if NODE_ENV=production.
 *
 * Lockout always uses RedisLockoutStore in this factory. Tests build
 * their own OtpServiceImpl with `InMemoryLockoutStore` and a mock
 * sender.
 */
export function createOtpService(): OtpService {
  const sender: OtpSender = env.OTP_SENDER === 'msg91' ? buildMsg91() : buildDevConsole();
  const lockoutStore = new RedisLockoutStore(redis);
  return new OtpServiceImpl({ sender, lockoutStore });
}

function buildMsg91(): Msg91Sender {
  if (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID) {
    throw new InternalError(
      'OTP_SENDER_MISCONFIG',
      'OTP_SENDER=msg91 requires MSG91_AUTH_KEY and MSG91_TEMPLATE_ID',
    );
  }
  return new Msg91Sender({
    authKey: env.MSG91_AUTH_KEY,
    templateId: env.MSG91_TEMPLATE_ID,
    ...(env.MSG91_SENDER_ID ? { senderId: env.MSG91_SENDER_ID } : {}),
  });
}

function buildDevConsole(): DevConsoleSender {
  if (env.NODE_ENV === 'production') {
    throw new InternalError(
      'OTP_SENDER_MISCONFIG',
      'OTP_SENDER=dev-console is not allowed in production. Set OTP_SENDER=msg91 and provide MSG91 credentials.',
    );
  }
  return new DevConsoleSender();
}
