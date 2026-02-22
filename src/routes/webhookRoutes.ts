import { Router, Request, Response } from 'express';
import { WebhooksHelper } from 'square';
import dotenv from 'dotenv';
import Transaction from '../models/Transaction';
import mongoose from 'mongoose';
import { FinancialService } from '../services/financialService';
import { ApiError, squareClient } from '../utils/squareApi';

dotenv.config();

const router = Router();

const SQUARE_WEBHOOK_SECRET = process.env.SQUARE_WEBHOOK_SECRET || '';
const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
const SQUARE_WEBHOOK_NOTIFICATION_URL = (
  process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || `${BACKEND_URL}/api/webhook/square-webhook`
).trim();

const getUserIdFromOrder = async (orderId: string): Promise<string | null> => {
  try {
    const orderResponse = await squareClient.orders.get({ orderId });
    const metadataUserId = orderResponse.order?.metadata?.userId;
    if (typeof metadataUserId === 'string' && metadataUserId.trim().length > 0) {
      return metadataUserId.trim();
    }

    const referenceId = orderResponse.order?.referenceId;
    if (typeof referenceId === 'string') {
      const match = referenceId.match(/^wallet_deposit:([a-f\d]{24})(?::|$)/i);
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch (error) {
    if (error instanceof ApiError) {
      console.warn(`Square Webhook: Failed to load order ${orderId} for metadata lookup.`, error.errors);
      return null;
    }
    console.warn(`Square Webhook: Unexpected error loading order ${orderId} for metadata lookup.`, error);
    return null;
  }

  return null;
};

router.post('/square-webhook', async (req: Request, res: Response) => {
  const signatureHeader = req.headers['x-square-hmacsha256-signature'];

  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return res.status(401).json({ message: 'Unauthorized: Missing webhook signature.' });
  }

  if (!SQUARE_WEBHOOK_SECRET) {
    console.error('Square webhook secret is not configured.');
    return res.status(500).json({ message: 'Webhook secret not configured.' });
  }

  const requestBody = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body ?? {});

  let signatureIsValid = false;
  try {
    signatureIsValid = await WebhooksHelper.verifySignature({
      requestBody,
      signatureHeader,
      signatureKey: SQUARE_WEBHOOK_SECRET,
      notificationUrl: SQUARE_WEBHOOK_NOTIFICATION_URL,
    });
  } catch (signatureError) {
    console.error('Square Webhook: Signature verification failed:', signatureError);
    return res.status(401).json({ message: 'Unauthorized: Invalid webhook signature.' });
  }

  if (!signatureIsValid) {
    return res.status(401).json({ message: 'Unauthorized: Invalid webhook signature.' });
  }

  let payload: any;
  try {
    payload = JSON.parse(requestBody);
  } catch (parseError) {
    console.error('Square Webhook: Invalid JSON payload.', parseError);
    return res.status(400).json({ message: 'Invalid JSON payload.' });
  }

  const type = payload?.type;
  const payment = payload?.data?.object?.payment;

  if (type === 'payment.updated' && payment?.status === 'COMPLETED') {
    const paymentId = typeof payment.id === 'string' ? payment.id : '';
    const orderId = typeof payment.order_id === 'string' ? payment.order_id : '';
    const amountMinor = Number(payment.amount_money?.amount);
    const currency = payment.amount_money?.currency;

    if (!paymentId || !Number.isFinite(amountMinor) || amountMinor <= 0) {
      console.error('Square Webhook: Missing payment id or amount in payment.updated event.');
      return res.status(400).json({ message: 'Missing payment amount information.' });
    }

    const amount = amountMinor / 100;
    console.log(`Square Webhook: Payment completed for order ${orderId || 'N/A'}. Amount: ${amount} ${currency || ''}`);

    const existingTransaction = await Transaction.findOne({
      type: 'Deposit',
      status: 'Completed',
      'details.paymentId': paymentId,
    }).lean();

    if (existingTransaction) {
      return res.status(200).json({ message: 'Duplicate payment event ignored.' });
    }

    let userIdFromMetadata = typeof payment.metadata?.userId === 'string' ? payment.metadata.userId : '';
    if (!userIdFromMetadata && orderId) {
      userIdFromMetadata = (await getUserIdFromOrder(orderId)) || '';
    }

    if (!userIdFromMetadata) {
      console.warn('Square Webhook: No userId in payment or order metadata. Cannot credit wallet automatically.');
      return res.status(200).json({ message: 'Payment processed, but user wallet not credited due to missing userId metadata.' });
    }

    if (!mongoose.Types.ObjectId.isValid(userIdFromMetadata)) {
      console.warn(`Square Webhook: Invalid metadata userId ${userIdFromMetadata}.`);
      return res.status(200).json({ message: 'Payment processed, but user wallet not credited due to invalid userId metadata.' });
    }

    try {
      const userObjectId = new mongoose.Types.ObjectId(userIdFromMetadata);
      await FinancialService.deposit(userIdFromMetadata, amount, {
        referenceType: 'square_payment',
        referenceId: paymentId,
        metadata: {
          orderId: orderId || undefined,
          currency,
        },
      });

      // Keep legacy transaction history until ledger UI cutover is complete.
      const transaction = new Transaction({
        userId: userObjectId,
        type: 'Deposit',
        amount: amount,
        status: 'Completed',
        details: {
          paymentId,
        },
      });
      await transaction.save();

      console.log(`Wallet for user ${userIdFromMetadata} credited with ${amount} ${currency || ''}.`);
    } catch (dbError: unknown) { // Explicitly type dbError as unknown
      console.error('Square Webhook: Database error updating wallet:', dbError);
      return res.status(500).json({ message: 'Internal server error during wallet update.' });
    }
  }

  res.status(200).json({ message: 'Webhook received and processed.' });
});

export default router;
