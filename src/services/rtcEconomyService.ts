import {
  RTC_DAILY_MINIMUM,
  RTC_PURCHASE_BUNDLES,
  RTC_REFILL_INTERVAL_MS,
  RtcPurchaseBundle,
} from '../config/economy';
import { GameMode } from '../domain/gameMode';
import { WalletDocument } from '../models/Wallet';
import { logLedgerEntry } from './ledgerService';
import { ensureWalletForUser } from './walletProvisioningService';

interface RtcReference {
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
}

const assertPositiveAmount = (amount: number, fieldName: string = 'amount') => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
};

const getWalletByUserId = async (userId: string): Promise<WalletDocument> => {
  return ensureWalletForUser(userId);
};

const getRtcBundle = (bundleId: string): RtcPurchaseBundle => {
  const bundle = RTC_PURCHASE_BUNDLES.find((item) => item.id === bundleId);
  if (!bundle) {
    throw new Error(`Unknown RTC bundle: ${bundleId}.`);
  }

  return bundle;
};

const assertRtcMode = (mode: GameMode) => {
  if (mode === GameMode.USD_CONTEST) {
    throw new Error('RTC economy operations are not allowed in USD_CONTEST mode.');
  }
};

export class RtcEconomyService {
  static async rtcPurchase(userId: string, bundleId: string, reference: RtcReference = {}) {
    const bundle = getRtcBundle(bundleId);
    const wallet = await getWalletByUserId(userId);

    wallet.rtcBalance += bundle.rtcAmount;
    await wallet.save();

    await logLedgerEntry({
      userId,
      currency: 'RTC',
      eventType: 'RTC_PURCHASE',
      direction: 'credit',
      amount: bundle.rtcAmount,
      balanceAfter: wallet.rtcBalance,
      referenceType: reference.referenceType ?? 'purchase_bundle',
      referenceId: reference.referenceId ?? bundle.id,
      metadata: {
        usdPrice: bundle.usdPrice,
        ...(reference.metadata ?? {}),
      },
    });

    await logLedgerEntry({
      userId,
      currency: 'RTC',
      eventType: 'SYSTEM_MINT',
      direction: 'credit',
      amount: bundle.rtcAmount,
      balanceAfter: wallet.rtcBalance,
      referenceType: 'purchase_bundle',
      referenceId: bundle.id,
      metadata: {
        reason: 'rtc_purchase',
      },
    });

    return { wallet, bundle };
  }

  static async rtcRefill(userId: string, now: Date = new Date()) {
    const wallet = await getWalletByUserId(userId);
    const elapsedMs = now.getTime() - wallet.lastRtcRefill.getTime();
    const eligible = elapsedMs >= RTC_REFILL_INTERVAL_MS;

    if (!eligible) {
      return {
        wallet,
        refilled: false,
        refillAmount: 0,
        nextEligibleAt: new Date(wallet.lastRtcRefill.getTime() + RTC_REFILL_INTERVAL_MS),
      };
    }

    let refillAmount = 0;
    if (wallet.rtcBalance < RTC_DAILY_MINIMUM) {
      refillAmount = RTC_DAILY_MINIMUM - wallet.rtcBalance;
      wallet.rtcBalance = RTC_DAILY_MINIMUM;
    }

    wallet.lastRtcRefill = now;
    await wallet.save();

    if (refillAmount > 0) {
      await logLedgerEntry({
        userId,
        currency: 'RTC',
        mode: GameMode.FREE_RTC_TABLE,
        eventType: 'RTC_REFILL',
        direction: 'credit',
        amount: refillAmount,
        balanceAfter: wallet.rtcBalance,
        referenceType: 'daily_refill',
      });

      await logLedgerEntry({
        userId,
        currency: 'RTC',
        eventType: 'SYSTEM_MINT',
        direction: 'credit',
        amount: refillAmount,
        balanceAfter: wallet.rtcBalance,
        referenceType: 'daily_refill',
        metadata: {
          floor: RTC_DAILY_MINIMUM,
        },
      });
    }

    return {
      wallet,
      refilled: refillAmount > 0,
      refillAmount,
      nextEligibleAt: new Date(now.getTime() + RTC_REFILL_INTERVAL_MS),
    };
  }

  static async rtcAnte(
    userId: string,
    amount: number,
    mode: GameMode = GameMode.FREE_RTC_TABLE,
    reference: RtcReference = {}
  ): Promise<WalletDocument> {
    assertPositiveAmount(amount);
    assertRtcMode(mode);

    const wallet = await getWalletByUserId(userId);
    if (wallet.rtcBalance < amount) {
      throw new Error('Insufficient RTC balance for ante.');
    }

    wallet.rtcBalance -= amount;
    await wallet.save();

    await logLedgerEntry({
      userId,
      currency: 'RTC',
      mode,
      eventType: 'RTC_ANTE',
      direction: 'debit',
      amount,
      balanceAfter: wallet.rtcBalance,
      referenceType: reference.referenceType,
      referenceId: reference.referenceId,
      metadata: reference.metadata,
    });

    return wallet;
  }

  static async rtcTournamentEntry(
    userId: string,
    amount: number,
    mode: GameMode,
    reference: RtcReference = {}
  ): Promise<WalletDocument> {
    assertPositiveAmount(amount, 'entryFee');
    assertRtcMode(mode);

    if (mode !== GameMode.RTC_TOURNAMENT && mode !== GameMode.RTC_SATELLITE) {
      throw new Error('rtcTournamentEntry only supports RTC_TOURNAMENT and RTC_SATELLITE modes.');
    }

    const wallet = await getWalletByUserId(userId);
    if (wallet.rtcBalance < amount) {
      throw new Error('Insufficient RTC balance for tournament entry.');
    }

    wallet.rtcBalance -= amount;
    await wallet.save();

    await logLedgerEntry({
      userId,
      currency: 'RTC',
      mode,
      eventType: 'RTC_TOURNAMENT_ENTRY',
      direction: 'debit',
      amount,
      balanceAfter: wallet.rtcBalance,
      referenceType: reference.referenceType ?? 'tournament',
      referenceId: reference.referenceId,
      metadata: reference.metadata,
    });

    return wallet;
  }

  static async rtcPrizeCredit(
    userId: string,
    amount: number,
    mode: GameMode,
    reference: RtcReference = {}
  ): Promise<WalletDocument> {
    assertPositiveAmount(amount);
    assertRtcMode(mode);

    const wallet = await getWalletByUserId(userId);
    wallet.rtcBalance += amount;
    await wallet.save();

    await logLedgerEntry({
      userId,
      currency: 'RTC',
      mode,
      eventType: 'RTC_PRIZE_CREDIT',
      direction: 'credit',
      amount,
      balanceAfter: wallet.rtcBalance,
      referenceType: reference.referenceType,
      referenceId: reference.referenceId,
      metadata: reference.metadata,
    });

    return wallet;
  }

  static async rtcBurnLog(
    userId: string,
    amount: number,
    mode: GameMode = GameMode.FREE_RTC_TABLE,
    options: RtcReference & { applyBalanceDebit?: boolean } = {}
  ): Promise<WalletDocument> {
    assertPositiveAmount(amount);
    assertRtcMode(mode);

    const wallet = await getWalletByUserId(userId);
    if (options.applyBalanceDebit) {
      if (wallet.rtcBalance < amount) {
        throw new Error('Insufficient RTC balance to burn.');
      }
      wallet.rtcBalance -= amount;
      await wallet.save();
    }

    await logLedgerEntry({
      userId,
      currency: 'RTC',
      mode,
      eventType: 'RTC_BURN',
      direction: 'debit',
      amount,
      balanceAfter: wallet.rtcBalance,
      referenceType: options.referenceType,
      referenceId: options.referenceId,
      metadata: options.metadata,
    });

    await logLedgerEntry({
      userId,
      currency: 'RTC',
      eventType: 'SYSTEM_BURN',
      direction: 'debit',
      amount,
      balanceAfter: wallet.rtcBalance,
      referenceType: options.referenceType ?? 'burn',
      referenceId: options.referenceId,
      metadata: {
        mode,
        ...(options.metadata ?? {}),
      },
    });

    return wallet;
  }
}
