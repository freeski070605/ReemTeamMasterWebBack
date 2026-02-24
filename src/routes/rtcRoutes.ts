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
  const { bundleId } = req.body ?? {};

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  if (!bundleId || typeof bundleId !== 'string') {
    return res.status(400).json({ message: 'bundleId is required.' });
  }

  return res.status(410).json({
    message: 'Direct RTC purchase endpoint is disabled. Use /api/payment/create-rtc-checkout and wait for Square webhook confirmation.',
  });
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
