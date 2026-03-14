import { Schema, model, Types, HydratedDocument, InferSchemaType } from 'mongoose';
import { RTC_DAILY_MINIMUM, RTC_STARTING_BALANCE } from '../config/economy';

const earningSchema = new Schema({
  matchId: { type: Schema.Types.ObjectId, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true }
}, { _id: false });

const walletSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  usdBalance: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
  rtcBalance: {
    type: Number,
    required: true,
    default: RTC_STARTING_BALANCE,
    min: 0,
  },
  lastRtcRefill: {
    type: Date,
    required: true,
    default: Date.now,
  },
  // Deprecated compatibility field. Existing runtime still reads/writes this until cutover.
  availableBalance: {
    type: Number,
    required: true,
    default: 0,
  },
  pendingWithdrawals: {
    type: Number,
    required: true,
    default: 0,
  },
  lifetimeDeposits: {
    type: Number,
    required: true,
    default: 0,
  },
  lifetimeWithdrawals: {
    type: Number,
    required: true,
    default: 0,
  },
  matchEarningsHistory: {
    type: [earningSchema],
    default: [],
  },
}, {
  timestamps: true,
});

walletSchema.pre('save', function syncLegacyUsdBalance() {
  const wallet = this as any;
  const usdChanged = wallet.isModified('usdBalance');
  const legacyChanged = wallet.isModified('availableBalance');

  if (typeof wallet.usdBalance !== 'number' || Number.isNaN(wallet.usdBalance)) {
    wallet.usdBalance = typeof wallet.availableBalance === 'number' && Number.isFinite(wallet.availableBalance)
      ? wallet.availableBalance
      : 0;
  }

  if (typeof wallet.availableBalance !== 'number' || Number.isNaN(wallet.availableBalance)) {
    wallet.availableBalance = wallet.usdBalance;
  }

  if (typeof wallet.rtcBalance !== 'number' || Number.isNaN(wallet.rtcBalance)) {
    wallet.rtcBalance = wallet.isNew ? RTC_STARTING_BALANCE : RTC_DAILY_MINIMUM;
  }

  if (!(wallet.lastRtcRefill instanceof Date) || Number.isNaN(wallet.lastRtcRefill.getTime())) {
    wallet.lastRtcRefill = new Date();
  }

  if (legacyChanged && !usdChanged) {
    wallet.usdBalance = wallet.availableBalance;
  } else if (usdChanged && !legacyChanged) {
    wallet.availableBalance = wallet.usdBalance;
  }

});

export type IWallet = InferSchemaType<typeof walletSchema>;
export type WalletDocument = HydratedDocument<IWallet>;

export default model<WalletDocument>('Wallet', walletSchema);
