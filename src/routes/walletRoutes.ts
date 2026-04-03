import { Router, Request, Response } from 'express';
import { ITokenPayload } from '../utils/jwt';
import WithdrawalRequest from '../models/WithdrawalRequest';
import Transaction from '../models/Transaction';
import authMiddleware from '../middleware/auth';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { FinancialService } from '../services/financialService';
import { ensureWalletForUser } from '../services/walletProvisioningService';
import Match from '../models/Match';
import Table from '../models/Table';
import { GameMode } from '../domain/gameMode';

dotenv.config();

const router = Router();

const MIN_WITHDRAWAL_AMOUNT = parseFloat(process.env.MIN_WITHDRAWAL_AMOUNT || '5');
const USD_GAME_MODES = new Set<GameMode>([GameMode.PRIVATE_USD_TABLE, GameMode.USD_CONTEST]);
const roundAmount = (value: number) => Number(value.toFixed(2));

// Request a withdrawal
router.post('/request-withdrawal', authMiddleware, async (req: Request, res: Response) => {
  const { amount, payoutMethod, payoutAddress } = req.body;
  const userId = (req.user as ITokenPayload)?.id; // From authMiddleware

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ message: 'Invalid amount provided.' });
  }

  if (amount < MIN_WITHDRAWAL_AMOUNT) {
    return res.status(400).json({ message: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT}.` });
  }

  if (!payoutMethod || !['Cash App', 'Apple Pay', 'PayPal'].includes(payoutMethod)) {
    return res.status(400).json({ message: 'Invalid payout method.' });
  }

  if (!payoutAddress || typeof payoutAddress !== 'string' || payoutAddress.trim() === '') {
    return res.status(400).json({ message: 'Invalid payout address.' });
  }

  try {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const wallet = await ensureWalletForUser(userId);

    if (!wallet) {
      return res.status(404).json({ message: 'Wallet not found for this user.' });
    }

    if (wallet.availableBalance < amount) {
      return res.status(400).json({ message: 'Insufficient funds for withdrawal.' });
    }

    // Create new withdrawal request
    const withdrawalRequest = new WithdrawalRequest({
      userId: userObjectId,
      amount,
      payoutMethod,
      payoutAddress,
      status: 'pending',
    });
    await withdrawalRequest.save();

    // Reserve USD funds through the new financial boundary.
    await FinancialService.withdraw(userId, amount, {
      referenceType: 'withdrawal_request',
      referenceId: withdrawalRequest._id.toString(),
      metadata: {
        payoutMethod,
      },
    });

    // Create a new transaction
    const transaction = new Transaction({
      userId: userObjectId,
      type: 'Withdrawal',
      amount: -amount,
      status: 'Pending',
      details: {
        withdrawalRequestId: withdrawalRequest._id,
      },
    });
    await transaction.save();

    res.status(200).json({ message: 'Withdrawal request submitted successfully.', requestId: withdrawalRequest._id });

  } catch (error) {
    console.error('Error submitting withdrawal request:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Get user's wallet balance
router.get('/balance', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const wallet = await ensureWalletForUser(userId);
    const currencyQuery =
      typeof req.query.currency === 'string' ? req.query.currency.toLowerCase() : 'usd';
    const isRtc = currencyQuery === 'rtc';

    res.status(200).json({
      balance: isRtc ? wallet.rtcBalance : wallet.usdBalance,
      currency: isRtc ? 'RTC' : 'USD',
    });
  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get user's dual wallet balances (USD + RTC)
router.get('/balances', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const wallet = await ensureWalletForUser(userId);

    res.status(200).json({
      usdBalance: wallet.usdBalance,
      rtcBalance: wallet.rtcBalance,
      lastRtcRefill: wallet.lastRtcRefill,
      legacyBalance: wallet.availableBalance,
    });
  } catch (error) {
    console.error('Error fetching wallet balances:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/account-stats', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const matches = await Match.find({
      status: 'completed',
      'players.userId': userObjectId,
    })
      .select('tableId players winner winType')
      .lean();

    const uniqueTableIds = [
      ...new Set(matches.map((match) => String(match.tableId ?? '')).filter(Boolean)),
    ].map((tableId) => new mongoose.Types.ObjectId(tableId));
    const tables = uniqueTableIds.length
      ? await Table.find({ _id: { $in: uniqueTableIds } }).select('mode').lean()
      : [];
    const tableModeById = new Map(tables.map((table) => [String(table._id), table.mode]));

    const summary = {
      matchesPlayed: 0,
      totalWins: 0,
      totalReems: 0,
      winRate: 0,
      usdEarned: 0,
      rtcEarned: 0,
      usdNet: 0,
      rtcNet: 0,
      biggestUsdPayout: 0,
      biggestRtcPayout: 0,
    };

    for (const match of matches) {
      const player = match.players?.find((entry) => String(entry.userId) === userId);
      if (!player) {
        continue;
      }

      const payout = Number(player.payout ?? 0);
      const earned = Math.max(0, payout);
      const isUsdMode = USD_GAME_MODES.has(
        (tableModeById.get(String(match.tableId ?? '')) as GameMode | undefined) ?? GameMode.FREE_RTC_TABLE
      );

      summary.matchesPlayed += 1;

      if (String(match.winner ?? '') === userId) {
        summary.totalWins += 1;
        if (match.winType === 'REEM') {
          summary.totalReems += 1;
        }
      }

      if (isUsdMode) {
        summary.usdEarned += earned;
        summary.usdNet += payout;
        summary.biggestUsdPayout = Math.max(summary.biggestUsdPayout, earned);
      } else {
        summary.rtcEarned += earned;
        summary.rtcNet += payout;
        summary.biggestRtcPayout = Math.max(summary.biggestRtcPayout, earned);
      }
    }

    summary.winRate = summary.matchesPlayed > 0 ? roundAmount((summary.totalWins / summary.matchesPlayed) * 100) : 0;
    summary.usdEarned = roundAmount(summary.usdEarned);
    summary.rtcEarned = roundAmount(summary.rtcEarned);
    summary.usdNet = roundAmount(summary.usdNet);
    summary.rtcNet = roundAmount(summary.rtcNet);
    summary.biggestUsdPayout = roundAmount(summary.biggestUsdPayout);
    summary.biggestRtcPayout = roundAmount(summary.biggestRtcPayout);

    res.status(200).json(summary);
  } catch (error) {
    console.error('Error fetching account stats:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Get user's withdrawal requests (for profile/history)
router.get('/my-withdrawals', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const withdrawalRequests = await WithdrawalRequest.find({ userId: userObjectId }).sort({ requestedAt: -1 });
    res.status(200).json(withdrawalRequests);
  } catch (error) {
    console.error('Error fetching withdrawal requests:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Get user's transactions
router.get('/transactions', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;
  const { currency } = req.query;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const query: any = { userId: new mongoose.Types.ObjectId(userId) };

    if (currency) {
      query.currency = currency as string;
    }

    const transactions = await Transaction.find(query).sort({ date: -1 });
    res.status(200).json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

export default router;
