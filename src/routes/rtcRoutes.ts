import { Router, Request, Response } from 'express';
import authMiddleware from '../middleware/auth';
import { ITokenPayload } from '../utils/jwt';
import { RTC_PURCHASE_BUNDLES } from '../config/economy';
import { RtcEconomyService } from '../services/rtcEconomyService';

const router = Router();

router.get('/bundles', (_req: Request, res: Response) => {
  res.status(200).json({
    bundles: RTC_PURCHASE_BUNDLES,
  });
});

router.post('/purchase', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;
  const { bundleId, paymentReferenceId } = req.body ?? {};

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  if (!bundleId || typeof bundleId !== 'string') {
    return res.status(400).json({ message: 'bundleId is required.' });
  }

  try {
    // TODO: Verify paymentReferenceId with payment provider before crediting in production.
    const { wallet, bundle } = await RtcEconomyService.rtcPurchase(userId, bundleId, {
      referenceType: 'rtc_purchase',
      referenceId: paymentReferenceId || bundleId,
      metadata: {
        paymentReferenceId: paymentReferenceId || null,
      },
    });

    return res.status(200).json({
      message: 'RTC purchase credited.',
      bundle,
      rtcBalance: wallet.rtcBalance,
    });
  } catch (error: any) {
    return res.status(400).json({
      message: error?.message || 'Failed to process RTC purchase.',
    });
  }
});

router.post('/refill', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const result = await RtcEconomyService.rtcRefill(userId);
    return res.status(200).json({
      rtcBalance: result.wallet.rtcBalance,
      refilled: result.refilled,
      refillAmount: result.refillAmount,
      nextEligibleAt: result.nextEligibleAt,
      lastRtcRefill: result.wallet.lastRtcRefill,
    });
  } catch (error: any) {
    return res.status(500).json({
      message: error?.message || 'Failed to process RTC refill.',
    });
  }
});

export default router;

