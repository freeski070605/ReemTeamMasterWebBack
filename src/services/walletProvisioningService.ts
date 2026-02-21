import { Types } from 'mongoose';
import { RTC_DAILY_MINIMUM } from '../config/economy';
import User from '../models/User';
import Wallet, { WalletDocument } from '../models/Wallet';

interface WalletBackfillSummary {
  created: number;
  normalized: number;
}

const toObjectId = (userId: string | Types.ObjectId): Types.ObjectId => {
  if (userId instanceof Types.ObjectId) {
    return userId;
  }
  return new Types.ObjectId(userId);
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const buildWalletDefaults = (userId: Types.ObjectId, now: Date = new Date()) => ({
  userId,
  usdBalance: 0,
  rtcBalance: RTC_DAILY_MINIMUM,
  lastRtcRefill: now,
  availableBalance: 0,
  pendingWithdrawals: 0,
  lifetimeDeposits: 0,
  lifetimeWithdrawals: 0,
});

const normalizeWalletDocument = (wallet: WalletDocument, now: Date = new Date()): boolean => {
  let didUpdate = false;

  if (!isFiniteNumber(wallet.usdBalance)) {
    wallet.usdBalance = isFiniteNumber(wallet.availableBalance) ? wallet.availableBalance : 0;
    didUpdate = true;
  }

  if (!isFiniteNumber(wallet.availableBalance)) {
    wallet.availableBalance = wallet.usdBalance;
    didUpdate = true;
  }

  if (!isFiniteNumber(wallet.rtcBalance)) {
    wallet.rtcBalance = RTC_DAILY_MINIMUM;
    didUpdate = true;
  }

  if (!(wallet.lastRtcRefill instanceof Date) || Number.isNaN(wallet.lastRtcRefill.getTime())) {
    wallet.lastRtcRefill = now;
    didUpdate = true;
  }

  if (!isFiniteNumber(wallet.pendingWithdrawals)) {
    wallet.pendingWithdrawals = 0;
    didUpdate = true;
  }

  if (!isFiniteNumber(wallet.lifetimeDeposits)) {
    wallet.lifetimeDeposits = 0;
    didUpdate = true;
  }

  if (!isFiniteNumber(wallet.lifetimeWithdrawals)) {
    wallet.lifetimeWithdrawals = 0;
    didUpdate = true;
  }

  if (!Array.isArray(wallet.matchEarningsHistory)) {
    (wallet as any).matchEarningsHistory = [];
    didUpdate = true;
  }

  return didUpdate;
};

export const ensureWalletForUser = async (userId: string | Types.ObjectId): Promise<WalletDocument> => {
  const userObjectId = toObjectId(userId);
  const now = new Date();
  let wallet = await Wallet.findOne({ userId: userObjectId });

  if (!wallet) {
    wallet = new Wallet(buildWalletDefaults(userObjectId, now));
    await wallet.save();
    return wallet;
  }

  if (normalizeWalletDocument(wallet, now)) {
    await wallet.save();
  }

  return wallet;
};

export const backfillWalletsForExistingUsers = async (): Promise<WalletBackfillSummary> => {
  const now = new Date();

  const users = await User.find({}, { _id: 1 }).lean();
  const existingWallets = await Wallet.find({}, { userId: 1 }).lean();
  const walletUserIds = new Set(existingWallets.map((wallet) => wallet.userId.toString()));

  let created = 0;
  for (const user of users) {
    const userId = user._id.toString();
    if (walletUserIds.has(userId)) {
      continue;
    }

    const wallet = new Wallet(buildWalletDefaults(user._id, now));
    await wallet.save();
    created += 1;
    walletUserIds.add(userId);
  }

  let normalized = 0;
  const cursor = Wallet.find().cursor();
  for await (const wallet of cursor) {
    if (normalizeWalletDocument(wallet, now)) {
      await wallet.save();
      normalized += 1;
    }
  }

  return { created, normalized };
};
