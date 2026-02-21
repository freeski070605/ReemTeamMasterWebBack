import mongoose from 'mongoose';
import { WalletDocument } from '../models/Wallet';
import { GameMode } from '../domain/gameMode';
import { logLedgerEntry } from './ledgerService';
import { ensureWalletForUser } from './walletProvisioningService';

interface FinancialReference {
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
}

const assertPositiveAmount = (amount: number, fieldName: string = 'amount') => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
};

const getWalletByUserId = async (
  userId: string,
  session?: mongoose.ClientSession
): Promise<WalletDocument> => {
  const wallet = await ensureWalletForUser(userId);
  if (session) {
    wallet.$session(session);
  }
  return wallet;
};

export class FinancialService {
  static async deposit(
    userId: string,
    amount: number,
    reference: FinancialReference = {}
  ): Promise<WalletDocument> {
    assertPositiveAmount(amount);

    const wallet = await getWalletByUserId(userId);
    wallet.usdBalance += amount;
    wallet.availableBalance += amount; // Compatibility mirror during transition.
    wallet.lifetimeDeposits += amount;
    await wallet.save();

    await logLedgerEntry({
      userId,
      currency: 'USD',
      eventType: 'USD_DEPOSIT',
      direction: 'credit',
      amount,
      balanceAfter: wallet.usdBalance,
      referenceType: reference.referenceType,
      referenceId: reference.referenceId,
      metadata: reference.metadata,
    });

    return wallet;
  }

  static async withdraw(
    userId: string,
    amount: number,
    reference: FinancialReference = {}
  ): Promise<WalletDocument> {
    assertPositiveAmount(amount);

    const wallet = await getWalletByUserId(userId);
    if (wallet.usdBalance < amount) {
      throw new Error('Insufficient USD funds for withdrawal.');
    }

    wallet.usdBalance -= amount;
    wallet.availableBalance -= amount; // Compatibility mirror during transition.
    wallet.pendingWithdrawals += amount;
    await wallet.save();

    await logLedgerEntry({
      userId,
      currency: 'USD',
      eventType: 'USD_WITHDRAWAL',
      direction: 'debit',
      amount,
      status: 'pending',
      balanceAfter: wallet.usdBalance,
      referenceType: reference.referenceType,
      referenceId: reference.referenceId,
      metadata: reference.metadata,
    });

    return wallet;
  }

  static async contestEntry(
    userId: string,
    entryFee: number,
    contestId: string,
    metadata: Record<string, unknown> = {}
  ): Promise<WalletDocument> {
    assertPositiveAmount(entryFee, 'entryFee');

    const wallet = await getWalletByUserId(userId);
    if (wallet.usdBalance < entryFee) {
      throw new Error('Insufficient USD balance for contest entry.');
    }

    wallet.usdBalance -= entryFee;
    wallet.availableBalance -= entryFee; // Compatibility mirror during transition.
    await wallet.save();

    await logLedgerEntry({
      userId,
      currency: 'USD',
      mode: GameMode.USD_CONTEST,
      eventType: 'USD_CONTEST_ENTRY',
      direction: 'debit',
      amount: entryFee,
      balanceAfter: wallet.usdBalance,
      referenceType: 'contest',
      referenceId: contestId,
      metadata,
    });

    return wallet;
  }

  static async payoutCredit(
    userId: string,
    amount: number,
    contestId: string,
    metadata: Record<string, unknown> = {}
  ): Promise<WalletDocument> {
    assertPositiveAmount(amount);

    const wallet = await getWalletByUserId(userId);
    wallet.usdBalance += amount;
    wallet.availableBalance += amount; // Compatibility mirror during transition.
    await wallet.save();

    await logLedgerEntry({
      userId,
      currency: 'USD',
      mode: GameMode.USD_CONTEST,
      eventType: 'USD_PAYOUT_CREDIT',
      direction: 'credit',
      amount,
      balanceAfter: wallet.usdBalance,
      referenceType: 'contest',
      referenceId: contestId,
      metadata,
    });

    return wallet;
  }

  static async logPrizePoolLock(params: {
    contestId: string;
    prizePool: number;
    entryFee: number;
    platformFee: number;
    playerCount: number;
  }) {
    assertPositiveAmount(params.prizePool, 'prizePool');

    await logLedgerEntry({
      currency: 'USD',
      mode: GameMode.USD_CONTEST,
      eventType: 'USD_PRIZE_POOL_LOCK',
      direction: 'info',
      amount: params.prizePool,
      referenceType: 'contest',
      referenceId: params.contestId,
      metadata: {
        entryFee: params.entryFee,
        platformFee: params.platformFee,
        playerCount: params.playerCount,
      },
    });
  }
}
