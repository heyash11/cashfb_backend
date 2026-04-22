export { AuthController } from './auth.controller.js';
export {
  AuthService,
  type AuthServiceDeps,
  type AuthTokens,
  type AuthedUserDto,
  type RequestOtpResult,
} from './auth.service.js';
export { createAuthRouter } from './auth.routes.js';
export {
  LogoutBodySchema,
  RefreshBodySchema,
  RequestLoginOtpBodySchema,
  RequestSignupOtpBodySchema,
  VerifyLoginOtpBodySchema,
  VerifySignupOtpBodySchema,
  type LogoutBody,
  type RefreshBody,
  type RequestLoginOtpBody,
  type RequestSignupOtpBody,
  type VerifyLoginOtpBody,
  type VerifySignupOtpBody,
} from './auth.schemas.js';
export type {
  OtpPurpose,
  OtpSendInput,
  OtpSender,
  OtpService,
  OtpVerifyInput,
} from './otp.types.js';
export { OtpServiceImpl } from './otp.service.js';
export { DevConsoleSender } from './otp.devconsole.js';
export { Msg91Sender, type Msg91SenderOptions } from './otp.msg91.js';
export { createOtpService } from './otp.factory.js';
export { InMemoryLockoutStore, type LockoutStore, RedisLockoutStore } from './lockout.store.js';
/** @deprecated Temporary Chunk-2 stub; replaced by OtpServiceImpl in Chunk 3. */
export { OtpServiceStub } from './otp.service.stub.js';
