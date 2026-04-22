import { AdminUserModel } from './AdminUser.model.js';
import { AdsConfigModel } from './AdsConfig.model.js';
import { AppConfigModel } from './AppConfig.model.js';
import { AuditLogModel } from './AuditLog.model.js';
import { BrandSponsorModel } from './BrandSponsor.model.js';
import { CmsContentModel } from './CmsContent.model.js';
import { CoinTransactionModel } from './CoinTransaction.model.js';
import { CounterModel } from './Counter.model.js';
import { CustomRoomModel } from './CustomRoom.model.js';
import { CustomRoomResultModel } from './CustomRoomResult.model.js';
import { DeviceFingerprintModel } from './DeviceFingerprint.model.js';
import { DonationModel } from './Donation.model.js';
import { LoginSessionModel } from './LoginSession.model.js';
import { NotificationModel } from './Notification.model.js';
import { OtpVerificationModel } from './OtpVerification.model.js';
import { PostModel } from './Post.model.js';
import { PostCompletionModel } from './PostCompletion.model.js';
import { PrizePoolModel } from './PrizePool.model.js';
import { PrizePoolWinnerModel } from './PrizePoolWinner.model.js';
import { RedeemCodeModel } from './RedeemCode.model.js';
import { RedeemCodeBatchModel } from './RedeemCodeBatch.model.js';
import { SubscriptionModel } from './Subscription.model.js';
import { SubscriptionPaymentModel } from './SubscriptionPayment.model.js';
import { TopDonorRankingModel } from './TopDonorRanking.model.js';
import { UserModel } from './User.model.js';
import { VoteModel } from './Vote.model.js';
import { WebhookEventModel } from './WebhookEvent.model.js';

/**
 * Barrel of every entity model, keyed by its MongoDB collection name.
 *
 * Consumers:
 *   - Integration tests that walk the full set (index verification,
 *     fixture cleanup).
 *   - Future admin-panel data-export endpoints.
 *
 * Discipline: adding a new schema file means adding it here. The
 * index verification test iterates this map, so a model left out of
 * the barrel is a model left out of index coverage.
 */
export const MODELS = {
  admin_users: AdminUserModel,
  ads_config: AdsConfigModel,
  app_config: AppConfigModel,
  audit_logs: AuditLogModel,
  brand_sponsors: BrandSponsorModel,
  cms_content: CmsContentModel,
  coin_transactions: CoinTransactionModel,
  counters: CounterModel,
  custom_rooms: CustomRoomModel,
  custom_room_results: CustomRoomResultModel,
  device_fingerprints: DeviceFingerprintModel,
  donations: DonationModel,
  login_sessions: LoginSessionModel,
  notifications: NotificationModel,
  otp_verifications: OtpVerificationModel,
  posts: PostModel,
  post_completions: PostCompletionModel,
  prize_pools: PrizePoolModel,
  prize_pool_winners: PrizePoolWinnerModel,
  redeem_codes: RedeemCodeModel,
  redeem_code_batches: RedeemCodeBatchModel,
  subscriptions: SubscriptionModel,
  subscription_payments: SubscriptionPaymentModel,
  top_donor_rankings: TopDonorRankingModel,
  users: UserModel,
  votes: VoteModel,
  webhook_events: WebhookEventModel,
} as const;

export type CollectionName = keyof typeof MODELS;
