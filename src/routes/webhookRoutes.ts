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

const EMPTY_ORDER_CONTEXT: SquareOrderContext = {
  userId: null,
  purchaseType: null,
  bundleId: null,
};

const PAYMENT_COMPLETION_EVENTS = new Set(['payment.updated', 'payment.created']);

const readMetadataString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeWebhookUrlCandidate = (value: string): string => {
  return value.trim().replace(/\/$/, '');
};

const buildWebhookUrlCandidates = (req: Request): string[] => {
  const candidates = new Set<string>();
  const addCandidate = (value: string | null | undefined) => {
    if (!value) {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      candidates.add(trimmed);
    }
    const normalized = normalizeWebhookUrlCandidate(trimmed);
    if (normalized && normalized !== trimmed) {
      candidates.add(normalized);
    }
  };

  addCandidate(SQUARE_WEBHOOK_NOTIFICATION_URL);

  const host = readMetadataString(req.header('x-forwarded-host')) || readMetadataString(req.header('host'));
  const forwardedProtoHeader = readMetadataString(req.header('x-forwarded-proto'));
  const forwardedProto = forwardedProtoHeader ? forwardedProtoHeader.split(',')[0]?.trim() : null;
  const protocolCandidates = [forwardedProto, req.protocol];

  if (host) {
    for (const protocol of protocolCandidates) {
      if (!protocol) {
        continue;
      }
      addCandidate(`${protocol}://${host}${req.originalUrl}`);
    }
  }

  return Array.from(candidates);
};

const parsePaymentNoteContext = (rawNote: string | null): SquareOrderContext => {
  if (!rawNote) {
    return EMPTY_ORDER_CONTEXT;
  }

  const note = rawNote.trim();

  const compactRtcMatch = note.match(/^rtc_bundle:([a-z0-9_]+):([a-f\d]{24})$/i);
  if (compactRtcMatch?.[1] && compactRtcMatch?.[2]) {
    return {
      userId: compactRtcMatch[2].toLowerCase(),
      purchaseType: 'rtc_bundle',
      bundleId: compactRtcMatch[1],
    };
  }

  const compactUsdMatch = note.match(/^(?:wallet_deposit|usd_deposit):([a-f\d]{24})$/i);
  if (compactUsdMatch?.[1]) {
    return {
      userId: compactUsdMatch[1].toLowerCase(),
      purchaseType: 'usd_deposit',
      bundleId: null,
    };
  }

  const rtcMatch = note.match(/rtc\s+bundle\s+([a-z0-9_]+)\s+purchase\s+for\s+user\s+([a-f\d]{24})/i);
  if (rtcMatch?.[1] && rtcMatch?.[2]) {
    return {
      userId: rtcMatch[2].toLowerCase(),
      purchaseType: 'rtc_bundle',
      bundleId: rtcMatch[1],
    };
  }

  const usdMatch = note.match(/wallet\s+deposit\s+for\s+user\s+([a-f\d]{24})/i);
  if (usdMatch?.[1]) {
    return {
      userId: usdMatch[1].toLowerCase(),
      purchaseType: 'usd_deposit',
      bundleId: null,
    };
  }

  return EMPTY_ORDER_CONTEXT;
};

const toUpperCaseOrNull = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  return value.toUpperCase();
};

const getOrderContext = async (orderId: string): Promise<SquareOrderContext> => {
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
      return EMPTY_ORDER_CONTEXT;
    }
    console.warn(`Square Webhook: Unexpected error loading order ${orderId} for metadata lookup.`, error);
    return EMPTY_ORDER_CONTEXT;
  }

  return EMPTY_ORDER_CONTEXT;
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
  let matchedNotificationUrl: string | null = null;
  const webhookUrlCandidates = buildWebhookUrlCandidates(req);

  for (const notificationUrl of webhookUrlCandidates) {
    try {
      const candidateValid = await WebhooksHelper.verifySignature({
        requestBody,
        signatureHeader,
        signatureKey: SQUARE_WEBHOOK_SECRET,
        notificationUrl,
      });

      if (candidateValid) {
        signatureIsValid = true;
        matchedNotificationUrl = notificationUrl;
        break;
      }
    } catch (signatureError) {
      console.warn(
        `Square Webhook: Signature verification error for candidate URL ${notificationUrl}.`,
        signatureError
      );
    }
  }

  if (!signatureIsValid) {
    return res.status(401).json({ message: 'Unauthorized: Invalid webhook signature.' });
  }

  if (matchedNotificationUrl && normalizeWebhookUrlCandidate(SQUARE_WEBHOOK_NOTIFICATION_URL) !== matchedNotificationUrl) {
    console.warn(
      `Square Webhook: Signature matched alternate URL ${matchedNotificationUrl}. Verify SQUARE_WEBHOOK_NOTIFICATION_URL value.`
    );
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
  const paymentStatus = toUpperCaseOrNull(readMetadataString(payment?.status));
  const isPaymentCompletionEvent = PAYMENT_COMPLETION_EVENTS.has(type) && paymentStatus === 'COMPLETED';

  if (isPaymentCompletionEvent) {
    const paymentId = readMetadataString(payment?.id) || '';
    const orderId = readMetadataString(payment?.order_id ?? payment?.orderId) || '';
    const amountMinor = Number(payment?.amount_money?.amount ?? payment?.amountMoney?.amount);
    const currency = readMetadataString(payment?.amount_money?.currency ?? payment?.amountMoney?.currency);
    const noteContext = parsePaymentNoteContext(
      readMetadataString(payment?.note ?? payment?.payment_note ?? payment?.paymentNote)
    );

    if (!paymentId || !Number.isFinite(amountMinor) || amountMinor <= 0) {
      console.error(`Square Webhook: Missing payment id or amount in ${type} completion event.`);
      return res.status(400).json({ message: 'Missing payment amount information.' });
    }

    const amount = amountMinor / 100;
    console.log(`Square Webhook: Payment completed for order ${orderId || 'N/A'}. Amount: ${amount} ${currency || ''}`);

    const orderContext = orderId ? await getOrderContext(orderId) : EMPTY_ORDER_CONTEXT;
    const userIdFromPayment = readMetadataString(payment.metadata?.userId);
    const purchaseTypeFromPayment = readMetadataString(payment.metadata?.purchaseType);
    const bundleIdFromPayment = readMetadataString(payment.metadata?.bundleId);
    const resolvedBundleId = bundleIdFromPayment || orderContext.bundleId || noteContext.bundleId || '';
    const purchaseType = purchaseTypeFromPayment
      || orderContext.purchaseType
      || noteContext.purchaseType
      || (resolvedBundleId ? 'rtc_bundle' : 'usd_deposit');
    const userIdFromMetadata = userIdFromPayment || orderContext.userId || noteContext.userId || '';
    const bundleId = resolvedBundleId;

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
