# DATA_MODEL.md

All Mongoose schemas for CashFB. Single database named `cashfb`. All collections use snake_case, all models use PascalCase.

**Global conventions:**

- `timestamps: true, versionKey: false` on every schema.
- `toJSON: { virtuals: true, transform: (_, ret) => { ret.id = ret._id; delete ret._id; } }`.
- Repository layer returns `.lean()` for reads, hydrated docs for mutations.
- Sensitive fields encrypted via `src/shared/encryption/envelope.ts`. Store `{ct, iv, tag, dekEnc}`.

---

## 1. users

```ts
const UserSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    email: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
    displayName: { type: String, trim: true, maxlength: 60 },
    avatarUrl: String,
    dob: { type: Date, required: true },
    declaredState: { type: String, required: true, index: true }, // ISO 3166-2:IN e.g. IN-MH
    socialLinks: {
      youtube: String,
      facebook: String,
      instagram: String,
    },

    // Coin economy
    coinBalance: { type: Number, default: 0, min: 0 }, // only $inc
    totalCoinsEarned: { type: Number, default: 0 },
    totalVotesCast: { type: Number, default: 0 },
    signupBonusGranted: { type: Boolean, default: false },
    lastVoteDate: { type: String, index: true }, // 'YYYY-MM-DD' IST

    // Subscription snapshot
    tier: { type: String, enum: ['PUBLIC', 'PRO', 'PRO_MAX'], default: 'PUBLIC', index: true },
    activeSubscriptionId: { type: Types.ObjectId, ref: 'Subscription' },
    tierExpiresAt: { type: Date, index: true },

    // KYC (lazy capture at first payout)
    kyc: {
      status: {
        type: String,
        enum: ['NONE', 'PENDING', 'VERIFIED', 'REJECTED'],
        default: 'NONE',
        index: true,
      },
      panCt: String,
      panIv: String,
      panTag: String,
      panDekEnc: String,
      panLast4: String,
      verifiedAt: Date,
    },

    // Compliance
    geoBlocked: { type: Boolean, default: false, index: true },
    ageVerified: { type: Boolean, default: false },
    blocked: {
      isBlocked: { type: Boolean, default: false, index: true },
      reason: String,
      at: Date,
      by: { type: Types.ObjectId, ref: 'AdminUser' },
    },

    // Anti-fraud
    primaryDeviceFingerprint: { type: String, index: true },
    lastLoginIp: String,
    lastLoginAt: Date,
    referredBy: { type: Types.ObjectId, ref: 'User', index: true },
    referralCode: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);

UserSchema.index({ tier: 1, tierExpiresAt: 1 });
UserSchema.index({ declaredState: 1, geoBlocked: 1 });
UserSchema.index({ 'blocked.isBlocked': 1 });
UserSchema.index({ 'kyc.panLast4': 1 });
```

---

## 2. subscriptions

```ts
const SubscriptionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    tier: { type: String, enum: ['PRO', 'PRO_MAX'], required: true },
    razorpaySubscriptionId: { type: String, required: true, unique: true, index: true },
    razorpayPlanId: { type: String, required: true },
    razorpayCustomerId: String,
    status: {
      type: String,
      enum: [
        'CREATED',
        'AUTHENTICATED',
        'ACTIVE',
        'PENDING',
        'HALTED',
        'CANCELLED',
        'COMPLETED',
        'PAUSED',
      ],
      required: true,
      index: true,
    },
    billingCycle: { type: String, enum: ['MONTHLY', 'YEARLY'], default: 'MONTHLY' },
    totalCount: Number,
    paidCount: { type: Number, default: 0 },
    remainingCount: Number,
    baseAmount: Number, // paise, pre-GST
    gstAmount: Number,
    totalAmount: Number,
    currentStart: Date,
    currentEnd: Date,
    chargeAt: Date,
    startAt: Date,
    endAt: Date,
    autoRenew: { type: Boolean, default: true },
    cancelledAt: Date,
    cancelReason: String,
    notes: Schema.Types.Mixed,
  },
  { timestamps: true },
);

SubscriptionSchema.index({ userId: 1, status: 1 });
SubscriptionSchema.index({ status: 1, currentEnd: 1 }); // expiry sweep
```

## 3. subscription_payments

```ts
const SubscriptionPaymentSchema = new Schema(
  {
    subscriptionId: { type: Types.ObjectId, ref: 'Subscription', required: true, index: true },
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    razorpayPaymentId: { type: String, required: true, unique: true, index: true },
    razorpayOrderId: { type: String, index: true },
    razorpayInvoiceId: String,
    amount: Number, // paise
    baseAmount: Number,
    gstAmount: Number,
    cgst: Number,
    sgst: Number,
    igst: Number,
    placeOfSupply: String, // state code
    sacCode: { type: String, default: '998439' },
    merchantGstin: String,
    customerGstin: String,
    invoiceNumber: { type: String, unique: true, sparse: true },
    invoicePdfUrl: String,
    method: String, // card, upi, netbanking
    status: {
      type: String,
      enum: ['CAPTURED', 'FAILED', 'REFUNDED', 'PARTIAL_REFUND'],
      index: true,
    },
    capturedAt: Date,
    refundedAt: Date,
    refundAmount: Number,
  },
  { timestamps: true },
);
```

---

## 4. donations

```ts
const DonationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', index: true },
    displayName: String,
    isAnonymous: { type: Boolean, default: false },
    amount: { type: Number, required: true }, // paise
    razorpayOrderId: { type: String, required: true, unique: true, index: true },
    razorpayPaymentId: { type: String, index: true },
    status: {
      type: String,
      enum: ['CREATED', 'CAPTURED', 'FAILED', 'REFUNDED'],
      default: 'CREATED',
      index: true,
    },
    message: { type: String, maxlength: 500 },
    socialLinks: { youtube: String, facebook: String, instagram: String },
    capturedAt: Date,
    ipAddress: String,
    notes: Schema.Types.Mixed,
  },
  { timestamps: true },
);

DonationSchema.index({ userId: 1, status: 1, createdAt: -1 });
DonationSchema.index({ status: 1, amount: -1 });
```

---

## 5. top_donor_rankings

Materialised view refreshed every 5 min by a cron. Do not compute on every home feed request.

```ts
const TopDonorRankingSchema = new Schema(
  {
    rank: { type: Number, required: true, index: true }, // 1 = top donor
    userId: { type: Types.ObjectId, ref: 'User', index: true },
    displayName: String,
    avatarUrl: String,
    socialLinks: { youtube: String, facebook: String, instagram: String },
    totalDonated: { type: Number, required: true }, // paise
    donationCount: Number,
    computedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

TopDonorRankingSchema.index({ rank: 1 });
```

---

## 6. posts

```ts
const PostSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 200 },
    description: String,
    dayKey: { type: String, required: true, index: true }, // 'YYYY-MM-DD' IST
    scheduledAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['DRAFT', 'SCHEDULED', 'LIVE', 'CLOSED'],
      default: 'DRAFT',
      index: true,
    },
    coinReward: { type: Number, default: 1 },
    tierRequired: { type: String, enum: ['PUBLIC', 'PRO', 'PRO_MAX'], default: 'PUBLIC' },
    adsConfig: {
      topBannerKey: String,
      bottomBannerKey: String,
    },
    createdBy: { type: Types.ObjectId, ref: 'AdminUser', required: true },
    publishedAt: Date,
    closedAt: Date,
  },
  { timestamps: true },
);

PostSchema.index({ dayKey: 1, status: 1, scheduledAt: 1 });
```

---

## 7. post_completions

```ts
const PostCompletionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    postId: { type: Types.ObjectId, ref: 'Post', required: true },
    dayKey: { type: String, required: true },
    completedAt: { type: Date, default: Date.now },
    coinAwarded: Number,
    coinTxId: { type: Types.ObjectId, ref: 'CoinTransaction' },
  },
  { timestamps: false },
);

PostCompletionSchema.index({ userId: 1, postId: 1 }, { unique: true }); // idempotent claim
PostCompletionSchema.index({ userId: 1, dayKey: 1 });
PostCompletionSchema.index({ postId: 1, completedAt: -1 });
```

---

## 8. votes

```ts
const VoteSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    dayKey: { type: String, required: true },
    target: { type: String, required: true },
    coinsSpent: { type: Number, default: 3 },
    ipAddress: String,
    device: String,
  },
  { timestamps: true },
);

VoteSchema.index({ userId: 1, dayKey: 1 }, { unique: true }); // once-per-day HARD rule
VoteSchema.index({ dayKey: 1, target: 1 });
VoteSchema.index({ dayKey: 1, createdAt: 1 });
```

---

## 9. coin_transactions

```ts
const CoinTransactionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['SIGNUP_BONUS', 'POST_REWARD', 'VOTE_SPEND', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'REFUND'],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true }, // +ve credit, -ve debit
    balanceAfter: { type: Number, required: true },
    reference: {
      kind: { type: String, enum: ['Post', 'Vote', 'Admin', 'System'] },
      id: { type: Types.ObjectId },
    },
    note: String,
  },
  { timestamps: true },
);

CoinTransactionSchema.index({ userId: 1, createdAt: -1 });
```

---

## 10. redeem_code_batches

```ts
const RedeemCodeBatchSchema = new Schema(
  {
    uploadedBy: { type: Types.ObjectId, ref: 'AdminUser', required: true },
    supplierName: { type: String, required: true }, // Xoxoday, Plum, Zaggle, Qwikcilver, Pine Labs
    supplierInvoiceNumber: String,
    supplierInvoiceUrl: String, // S3 key
    denomination: { type: Number, required: true, default: 5000 }, // paise, ₹50 = 5000
    count: { type: Number, required: true },
    totalValue: Number,
    notes: String,
    status: { type: String, enum: ['STAGED', 'LIVE', 'EXHAUSTED'], default: 'STAGED', index: true },
  },
  { timestamps: true },
);
```

## 11. redeem_codes

```ts
const RedeemCodeSchema = new Schema(
  {
    batchId: { type: Types.ObjectId, ref: 'RedeemCodeBatch', required: true, index: true },
    denomination: { type: Number, required: true },
    // encrypted at rest
    codeCt: { type: String, required: true },
    codeIv: String,
    codeTag: String,
    codeDekEnc: String,
    codeHash: { type: String, required: true, unique: true }, // HMAC-SHA256 for dedupe
    status: {
      type: String,
      enum: ['AVAILABLE', 'PUBLISHED', 'COPIED', 'CLAIMED', 'EXPIRED', 'VOID'],
      default: 'AVAILABLE',
      required: true,
      index: true,
    },
    postId: { type: Types.ObjectId, ref: 'Post', index: true },
    publishedAt: Date,
    firstCopiedBy: { type: Types.ObjectId, ref: 'User' },
    firstCopiedAt: Date,
    copyCount: { type: Number, default: 0 },
    claimedBy: { type: Types.ObjectId, ref: 'User', index: true },
    claimedAt: Date,
    voidedReason: String,
  },
  { timestamps: true },
);

RedeemCodeSchema.index({ status: 1, batchId: 1 });
RedeemCodeSchema.index({ postId: 1, status: 1 });
```

---

## 12. prize_pools

```ts
const PrizePoolSchema = new Schema(
  {
    dayKey: { type: String, required: true, unique: true },
    yesterdayVoteCount: { type: Number, required: true },
    baseRate: { type: Number, required: true }, // paise per vote
    totalPool: { type: Number, required: true }, // paise
    giftCodeBudget: Number, // 70%
    customRoomBudget: Number, // 30%
    proMultiplier: { type: Number, default: 5 },
    proMaxMultiplier: { type: Number, default: 10 },
    status: {
      type: String,
      enum: ['CALCULATED', 'PUBLISHED', 'CLOSED'],
      default: 'CALCULATED',
      index: true,
    },
    calculatedAt: Date,
    publishedAt: Date,
    closedAt: Date,
  },
  { timestamps: true },
);
```

## 13. prize_pool_winners

```ts
const PrizePoolWinnerSchema = new Schema(
  {
    dayKey: { type: String, required: true, index: true },
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['GIFT_CODE', 'CUSTOM_ROOM'], required: true },
    tier: { type: String, enum: ['PUBLIC', 'PRO', 'PRO_MAX'] },
    baseAmount: Number,
    multiplier: { type: Number, default: 1 },
    finalAmount: Number,
    redeemCodeId: { type: Types.ObjectId, ref: 'RedeemCode' },
    customRoomId: { type: Types.ObjectId, ref: 'CustomRoom' },
    tdsDeducted: { type: Number, default: 0 }, // 30% under 194BA, paise
    tdsChallanNo: String,
    form16aIssuedAt: Date,
    panAtPayout: String, // last-4 masked
    payoutStatus: {
      type: String,
      enum: ['PENDING', 'RELEASED', 'WITHHELD', 'VOID'],
      default: 'PENDING',
    },
    releasedAt: Date,
  },
  { timestamps: true },
);

PrizePoolWinnerSchema.index({ dayKey: 1, userId: 1 });
PrizePoolWinnerSchema.index({ userId: 1, type: 1 });

// Prevent duplicate-award of the same gift code or same custom-room entry
// to the same user on the same day. Partial filters let each unique index
// apply to its own prize type without fighting the other.
PrizePoolWinnerSchema.index(
  { userId: 1, dayKey: 1, type: 1, redeemCodeId: 1 },
  { unique: true, partialFilterExpression: { type: 'GIFT_CODE' } },
);
PrizePoolWinnerSchema.index(
  { userId: 1, dayKey: 1, type: 1, customRoomId: 1 },
  { unique: true, partialFilterExpression: { type: 'CUSTOM_ROOM' } },
);
```

---

## 14. custom_rooms

```ts
const CustomRoomSchema = new Schema(
  {
    game: { type: String, enum: ['BGMI', 'FF'], required: true, index: true },
    dayKey: { type: String, required: true, index: true },
    scheduledAt: { type: Date, required: true, index: true },
    // encrypted at rest
    roomIdCt: String,
    roomIdIv: String,
    roomIdTag: String,
    roomIdDekEnc: String,
    roomPwdCt: String,
    roomPwdIv: String,
    roomPwdTag: String,
    roomPwdDekEnc: String,
    visibleFromAt: Date,
    resultEnabledAt: Date, // scheduledAt + 30 min
    status: {
      type: String,
      enum: ['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED'],
      default: 'SCHEDULED',
      index: true,
    },
    pageNumber: Number,
    notice: String,
    tierRequired: { type: String, enum: ['PUBLIC', 'PRO', 'PRO_MAX'], default: 'PUBLIC' },
    participantCount: { type: Number, default: 0 },
    createdBy: { type: Types.ObjectId, ref: 'AdminUser', required: true },
  },
  { timestamps: true },
);

CustomRoomSchema.index({ dayKey: 1, game: 1, scheduledAt: 1 });
CustomRoomSchema.index({ status: 1, scheduledAt: 1 });
```

## 15. custom_room_results

```ts
const CustomRoomResultSchema = new Schema(
  {
    roomId: { type: Types.ObjectId, ref: 'CustomRoom', required: true, unique: true, index: true },
    inRoomImageUrl: String, // S3 key
    top1: {
      imageUrl: String,
      squadName: String,
      winners: [{ userId: Types.ObjectId, prize: Number }],
    },
    top2: {
      imageUrl: String,
      squadName: String,
      winners: [{ userId: Types.ObjectId, prize: Number }],
    },
    top3: {
      imageUrl: String,
      squadName: String,
      winners: [{ userId: Types.ObjectId, prize: Number }],
    },
    extra: {
      imageUrl: String,
      squadName: String,
      winners: [{ userId: Types.ObjectId, prize: Number }],
    },
    publishedAt: Date,
    visibleFromAt: Date, // mirrors room.resultEnabledAt
    publishedBy: { type: Types.ObjectId, ref: 'AdminUser' },
  },
  { timestamps: true },
);
```

---

## 16. brand_sponsors

```ts
const BrandSponsorSchema = new Schema(
  {
    slot: { type: Number, min: 1, max: 3, required: true, index: true },
    imageUrl: { type: String, required: true },
    linkUrl: String,
    title: String,
    priority: { type: Number, default: 0 },
    startAt: Date,
    endAt: Date,
    status: { type: String, enum: ['ACTIVE', 'PAUSED', 'EXPIRED'], default: 'ACTIVE', index: true },
  },
  { timestamps: true },
);

BrandSponsorSchema.index({ slot: 1, status: 1, priority: -1 });
```

---

## Supporting collections

### ads_config

```ts
const AdsConfigSchema = new Schema(
  {
    placementKey: { type: String, required: true, unique: true, index: true },
    // 'home_top_banner','timer_top_banner','timer_bottom_banner',
    // 'redeem_code_bottom_banner','custom_room_bottom_banner','result_middle_banner'
    type: {
      type: String,
      enum: ['BANNER', 'INTERSTITIAL', 'REWARDED_VIDEO', 'NATIVE'],
      required: true,
    },
    network: { type: String, enum: ['ADMOB', 'UNITY', 'APPLOVIN', 'IRONSOURCE'], required: true },
    adUnitIdAndroid: String,
    adUnitIdIOS: String,
    fallbackAdUnitId: String,
    enabled: { type: Boolean, default: true },
    minTierToHide: { type: String, enum: ['NONE', 'PRO', 'PRO_MAX'], default: 'NONE' },
    refreshSeconds: Number,
    updatedBy: { type: Types.ObjectId, ref: 'AdminUser' },
  },
  { timestamps: true },
);
```

### notifications

```ts
const NotificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', index: true }, // null = broadcast
    type: {
      type: String,
      enum: [
        'POST_PUBLISHED',
        'ROOM_PUBLISHED',
        'RESULT_PUBLISHED',
        'POOL_PUBLISHED',
        'SUBSCRIPTION_CHARGED',
        'SUBSCRIPTION_EXPIRED',
        'KYC_REQUIRED',
        'CUSTOM',
      ],
      required: true,
      index: true,
    },
    title: String,
    body: String,
    payload: Schema.Types.Mixed,
    fcmMessageId: String,
    deliveredAt: Date,
    readAt: Date,
  },
  { timestamps: true },
);

NotificationSchema.index({ userId: 1, createdAt: -1 });
```

### otp_verifications (TTL auto-cleanup)

```ts
const OtpSchema = new Schema(
  {
    channel: { type: String, enum: ['SMS', 'EMAIL'], required: true },
    destination: { type: String, required: true, index: true },
    otpHash: { type: String, required: true },
    salt: String,
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    purpose: { type: String, enum: ['SIGNUP', 'LOGIN', 'PHONE_CHANGE', 'EMAIL_CHANGE'] },
    ipAddress: String,
    deviceFingerprint: String,
    consumedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OtpSchema.index({ destination: 1, createdAt: -1 });
```

### admin_users

```ts
const AdminUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true }, // bcrypt cost 12
    name: String,
    role: {
      type: String,
      enum: ['SUPER_ADMIN', 'CONTENT_ADMIN', 'PAYMENT_ADMIN', 'SUPPORT_ADMIN'],
      required: true,
      index: true,
    },
    permissions: [String],
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secret: String, // TOTP, encrypted
      recoveryCodes: [String],
    },
    ipAllowlist: [String],
    lastLoginAt: Date,
    lastLoginIp: String,
    disabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);
```

### audit_logs

```ts
const AuditLogSchema = new Schema(
  {
    actorId: { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },
    actorEmail: String,
    action: { type: String, required: true, index: true }, // 'POST_CREATE','SUBSCRIPTION_CANCEL', etc.
    resource: { kind: String, id: Types.ObjectId },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
  },
  { timestamps: true },
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ actorId: 1, createdAt: -1 });
AuditLogSchema.index({ 'resource.kind': 1, 'resource.id': 1 });
```

### cms_content

```ts
const CmsContentSchema = new Schema(
  {
    key: {
      type: String,
      enum: ['TERMS', 'HOW_DISTRIBUTE', 'FAQ', 'PRIVACY', 'GRIEVANCE'],
      unique: true,
    },
    html: String,
    version: { type: Number, default: 1 },
    updatedBy: { type: Types.ObjectId, ref: 'AdminUser' },
  },
  { timestamps: true },
);
```

### app_config (single-doc)

```ts
const AppConfigSchema = new Schema(
  {
    key: { type: String, default: 'default', unique: true },
    baseRatePerVote: { type: Number, default: 100 }, // paise = ₹1
    signupBonusCoins: { type: Number, default: 3 },
    coinsPerPost: { type: Number, default: 1 },
    coinsPerVote: { type: Number, default: 3 },
    giftCodeDenomination: { type: Number, default: 5000 },
    proMultiplier: { type: Number, default: 5 },
    proMaxMultiplier: { type: Number, default: 10 },
    voteWindowIst: {
      start: { type: String, default: '00:00' },
      end: { type: String, default: '23:59' },
    },
    blockedStates: { type: [String], default: [] },
    kycThresholdAmount: { type: Number, default: 10000 }, // paise
    ageMin: { type: Number, default: 18 },
    maintenanceMode: { type: Boolean, default: false },
    featureFlags: Schema.Types.Mixed,

    // Razorpay plan IDs written by scripts/migrate-razorpay-plans.ts
    // so the admin panel can swap plans without a redeploy.
    razorpayPlanIds: {
      PRO: String,
      PRO_MAX: String,
    },
  },
  { timestamps: true },
);
```

### login_sessions (TTL auto-cleanup)

```ts
const LoginSessionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    jti: { type: String, required: true, unique: true },
    deviceId: String,
    deviceFingerprint: String,
    userAgent: String,
    ip: String,
    refreshTokenHash: String, // sha256 of refresh
    family: String, // rotation family id
    revokedAt: Date,
    expiresAt: Date,
  },
  { timestamps: true },
);

LoginSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
LoginSessionSchema.index({ userId: 1, revokedAt: 1 });
```

### device_fingerprints

```ts
const DeviceFingerprintSchema = new Schema(
  {
    fingerprint: { type: String, required: true, unique: true, index: true },
    androidId: String,
    imeiHash: String, // never raw IMEI
    firstSeenUserId: { type: Types.ObjectId, ref: 'User' },
    linkedUserIds: [{ type: Types.ObjectId, ref: 'User' }],
    suspiciousScore: { type: Number, default: 0 },
    blocked: { type: Boolean, default: false },
  },
  { timestamps: true },
);

DeviceFingerprintSchema.index({ blocked: 1 });
```

### webhook_events (Razorpay idempotency)

```ts
const WebhookEventSchema = new Schema(
  {
    source: { type: String, enum: ['RAZORPAY', 'FCM'], required: true },
    eventId: { type: String, required: true, unique: true }, // X-Razorpay-Event-Id
    eventType: { type: String, index: true },
    payload: Schema.Types.Mixed,
    status: {
      type: String,
      enum: ['RECEIVED', 'PROCESSING', 'DONE', 'FAILED'],
      default: 'RECEIVED',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: String,
    receivedAt: Date,
    processedAt: Date,
  },
  { timestamps: true },
);
```

### counters

Sequential counter used for GST invoice numbering (`CF/{FY}/{NNNNNN}`) and any
other monotonic-sequence need. Atomic via `findOneAndUpdate` + `$inc`.

```ts
const CounterSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true }, // e.g. 'invoice:2026-27'
    value: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);
```

---

## Hot-path index summary

The queries that matter most for performance:

- `users: {phone: 1}` unique, `{tier: 1, tierExpiresAt: 1}`, `{'kyc.panLast4': 1}`
- `votes: {userId: 1, dayKey: 1}` unique, `{dayKey: 1, target: 1}`
- `post_completions: {userId: 1, postId: 1}` unique
- `redeem_codes: {status: 1, batchId: 1}`, `{postId: 1, status: 1}`, `{codeHash: 1}` unique
- `subscriptions: {razorpaySubscriptionId: 1}` unique, `{status: 1, currentEnd: 1}`
- `donations: {razorpayOrderId: 1}` unique, `{status: 1, amount: -1}`
- `custom_rooms: {dayKey: 1, game: 1, scheduledAt: 1}`
- `webhook_events: {eventId: 1}` unique
- `counters: {key: 1}` unique
- `prize_pool_winners`: partial unique on `{userId, dayKey, type, redeemCodeId}` when `type = GIFT_CODE`, same with `customRoomId` when `type = CUSTOM_ROOM`
