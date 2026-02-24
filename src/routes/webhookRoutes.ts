import { Router, Request, Response } from 'express';
import { WebhooksHelper } from 'square';
import dotenv from 'dotenv';
import Transaction from '../models/Transaction';
import mongoose from 'mongoose';
import { FinancialService } from '../services/financialService';
import { ApiError, squareClient } from '../utils/squareApi';
import LedgerEntry from '../models/LedgerEntry';
import { RTC_PURCHASE_BUNDLES } from '../config/economy';
import { RtcEconomyService } from '../services/rtcEconomyService';

dotenv.config();

const router = Router();

const SQUARE_WEBHOOK_SECRET = process.env.SQUARE_WEBHOOK_SECRET || '';
const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
const SQUARE_WEBHOOK_NOTIFICATION_URL = (
  process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || `${BACKEND_URL}/api/webhook/square-webhook`
).trim();

interface SquareOrderContext {
  userId: string | null;
  purchaseType: string | null;
  bundleId: string | null;
}

const readMetadataString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getOrderContext = async (orderId: string): Promise<SquareOrderContext> => {
  const emptyContext: SquareOrderContext = {
    userId: null,
    purchaseType: null,
    bundleId: null,
  };

  try {
    const orderResponse = await squareClient.orders.get({ orderId });
    const metadata = orderResponse.order?.metadata ?? {};

    const metadataUserId = readMetadataString(metadata.userId);
    const purchaseType = readMetadataString(metadata.purchaseType);
    const bundleId = readMetadataString(metadata.bundleId);

    if (metadataUserId) {
      return {
        userId: metadataUserId,
        purchaseType,
        bundleId,
      };
    }

    const referenceId = orderResponse.order?.referenceId;
    if (typeof referenceId === 'string') {
      const match = referenceId.match(/^(?:wallet_deposit|rtc_purchase):([a-f\d]{24})(?::|$)/i);
      if (match?.[1]) {
        return {
          userId: match[1],
          purchaseType,
          bundleId,
        };
      }
    }
  } catch (error) {
    if (error instanceof ApiError) {
      console.warn(`Square Webhook: Failed to load order ${orderId} for metadata lookup.`, error.errors);
      return emptyContext;
    }
    console.warn(`Square Webhook: Unexpected error loading order ${orderId} for metadata lookup.`, error);
    return emptyContext;
  }

  return emptyContext;
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

    const orderContext = orderId ? await getOrderContext(orderId) : {
      userId: null,
      purchaseType: null,
      bundleId: null,
    };
    const userIdFromPayment = readMetadataString(payment.metadata?.userId);
    const purchaseTypeFromPayment = readMetadataString(payment.metadata?.purchaseType);
    const bundleIdFromPayment = readMetadataString(payment.metadata?.bundleId);

    const userIdFromMetadata = userIdFromPayment || orderContext.userId || '';
    const purchaseType = purchaseTypeFromPayment || orderContext.purchaseType || 'usd_deposit';
    const bundleId = bundleIdFromPayment || orderContext.bundleId || '';

    if (purchaseType === 'rtc_bundle') {
      if (!bundleId) {
        console.warn('Square Webhook: RTC payment missing bundleId metadata.');
        return res.status(200).json({ message: 'Payment processed, but RTC wallet not credited due to missing bundleId metadata.' });
      }

      if (!userIdFromMetadata) {
        console.warn('Square Webhook: RTC payment missing userId metadata.');
        return res.status(200).json({ message: 'Payment processed, but RTC wallet not credited due to missing userId metadata.' });
      }

      if (!mongoose.Types.ObjectId.isValid(userIdFromMetadata)) {
        console.warn(`Square Webhook: Invalid RTC metadata userId ${userIdFromMetadata}.`);
        return res.status(200).json({ message: 'Payment processed, but RTC wallet not credited due to invalid userId metadata.' });
      }

      const bundle = RTC_PURCHASE_BUNDLES.find((item) => item.id === bundleId);
      if (!bundle) {
        console.warn(`Square Webhook: Unknown RTC bundle ${bundleId}.`);
        return res.status(200).json({ message: 'Payment processed, but RTC wallet not credited due to unknown bundle.' });
      }

      const expectedAmountMinor = Math.round(bundle.usdPrice * 100);
      if (amountMinor !== expectedAmountMinor) {
        console.warn(
          `Square Webhook: RTC amount mismatch for bundle ${bundleId}. expected=${expectedAmountMinor}, actual=${amountMinor}.`
        );
        return res.status(200).json({ message: 'Payment processed, but RTC wallet not credited due to amount mismatch.' });
      }

      const existingRtcCredit = await LedgerEntry.findOne({
        currency: 'RTC',
        eventType: 'RTC_PURCHASE',
        referenceType: 'square_payment',
        referenceId: paymentId,
      }).lean();

      if (existingRtcCredit) {
        return res.status(200).json({ message: 'Duplicate RTC payment event ignored.' });
      }

      try {
        await RtcEconomyService.rtcPurchase(userIdFromMetadata, bundleId, {
          referenceType: 'square_payment',
          referenceId: paymentId,
          metadata: {
            orderId: orderId || undefined,
            currency,
            amountMinor,
            purchaseType,
          },
        });

        console.log(
          `RTC wallet for user ${userIdFromMetadata} credited with ${bundle.rtcAmount} RTC from payment ${paymentId}.`
        );
      } catch (dbError: unknown) {
        console.error('Square Webhook: Database error updating RTC wallet:', dbError);
        return res.status(500).json({ message: 'Internal server error during RTC wallet update.' });
      }

      return res.status(200).json({ message: 'RTC payment webhook processed successfully.' });
    }

    const existingTransaction = await Transaction.findOne({
      type: 'Deposit',
      status: 'Completed',
      'details.paymentId': paymentId,
    }).lean();

    if (existingTransaction) {
      return res.status(200).json({ message: 'Duplicate payment event ignored.' });
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
          purchaseType,
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
