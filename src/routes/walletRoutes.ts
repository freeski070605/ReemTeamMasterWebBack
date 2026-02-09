import { Router, Request, Response } from 'express';
import Wallet from '../models/Wallet';
import { ITokenPayload } from '../utils/jwt';
import WithdrawalRequest from '../models/WithdrawalRequest';
import Transaction from '../models/Transaction';
import authMiddleware from '../middleware/auth';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();

const MIN_WITHDRAWAL_AMOUNT = parseFloat(process.env.MIN_WITHDRAWAL_AMOUNT || '5');

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
    const wallet = await Wallet.findOne({ userId: userObjectId });

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

    // Update wallet balances
    wallet.availableBalance -= amount;
    wallet.pendingWithdrawals += amount;
    await wallet.save();

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
    const wallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(userId) });
    if (!wallet) {
      return res.status(404).json({ message: 'Wallet not found' });
    }
    res.status(200).json({ balance: wallet.availableBalance });
  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    res.status(500).json({ message: 'Internal server error' });
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

// Admin: Get all pending withdrawals
router.get('/admin/withdrawals', authMiddleware, async (req: Request, res: Response) => {
  // TODO: Add admin role check
  try {
    const withdrawalRequests = await WithdrawalRequest.find({ status: 'pending' }).populate('userId', 'username email').sort({ requestedAt: 1 });
    res.status(200).json(withdrawalRequests);
  } catch (error) {
    console.error('Error fetching admin withdrawals:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Admin: Process withdrawal
router.post('/admin/withdrawals/:id/process', authMiddleware, async (req: Request, res: Response) => {
  // TODO: Add admin role check
  const { id } = req.params;
  const { action, transactionId } = req.body; // action: 'approve' | 'reject'

  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ message: 'Invalid action.' });
  }

  try {
    const request = await WithdrawalRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: 'Request not found.' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request is not pending.' });
    }

    const wallet = await Wallet.findOne({ userId: request.userId });
    if (!wallet) {
      return res.status(404).json({ message: 'User wallet not found.' });
    }

    if (action === 'approve') {
      request.status = 'approved';
      request.processedAt = new Date();
      request.transactionId = transactionId || 'MANUAL';
      
      // Funds were already deducted from available balance, but kept in pending.
      // Now we just reduce pending.
      wallet.pendingWithdrawals -= request.amount;
      wallet.lifetimeWithdrawals += request.amount;

      // Update the transaction status
      await Transaction.findOneAndUpdate(
        { "details.withdrawalRequestId": request._id },
        { status: 'Completed' }
      );
    } else {
      request.status = 'rejected';
      request.processedAt = new Date();
      
      // Refund the amount to available balance
      wallet.pendingWithdrawals -= request.amount;
      wallet.availableBalance += request.amount;

      // Update the transaction status
      await Transaction.findOneAndUpdate(
        { "details.withdrawalRequestId": request._id },
        { status: 'Failed' }
      );
    }

    await request.save();
    await wallet.save();

    res.status(200).json({ message: `Withdrawal ${action}ed successfully.` });
  } catch (error) {
    console.error('Error processing withdrawal:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Get user's transactions
router.get('/transactions', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const transactions = await Transaction.find({ userId: new mongoose.Types.ObjectId(userId) }).sort({ date: -1 });
    res.status(200).json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

export default router;
