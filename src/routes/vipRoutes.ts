import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import authMiddleware from '../middleware/auth';
import User from '../models/User';
import { squareClient, ApiError, FRONTEND_URL } from '../utils/squareApi';
import { buildVipPayload } from '../utils/vip';

const router = Router();

const resolveSquareLocationId = async (): Promise<string | null> => {
  const configuredLocationId = (process.env.SQUARE_LOCATION_ID || '').trim();

  const locationsResponse = await squareClient.locations.list();
  const locations = locationsResponse.locations ?? [];
  if (locations.length === 0) {
    return null;
  }

  const activeLocations = locations.filter(
    (location) => (location.status || '').toUpperCase() === 'ACTIVE'
  );
  const candidateLocations = activeLocations.length > 0 ? activeLocations : locations;

  if (configuredLocationId) {
    const exactMatch = candidateLocations.find((location) => location.id === configuredLocationId);
    if (exactMatch?.id) {
      return exactMatch.id;
    }

    const fallback = candidateLocations[0];
    console.warn(
      `Configured SQUARE_LOCATION_ID ${configuredLocationId} is not available to this token. Falling back to ${fallback?.id}.`
    );
    return fallback?.id || null;
  }

  return candidateLocations[0]?.id || null;
};

const handleSquareError = (res: Response, error: unknown, fallbackMessage: string) => {
  if (error instanceof ApiError) {
    console.error('Square API Error:', error.errors);
    const isSquareAuthFailure = error.statusCode === 401
      || (error.errors ?? []).some((entry) => entry.category === 'AUTHENTICATION_ERROR');
    if (isSquareAuthFailure) {
      const currentSquareEnvironment = (process.env.SQUARE_ENVIRONMENT || 'sandbox').trim().toLowerCase();
      return res.status(502).json({
        message: `Square credentials are invalid for ${currentSquareEnvironment}. Verify SQUARE_ACCESS_TOKEN and SQUARE_ENVIRONMENT (sandbox vs production).`,
        errors: error.errors,
      });
    }
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400
      ? error.statusCode
      : 502;
    return res.status(status).json({ message: 'Square API Error', errors: error.errors });
  }

  console.error(fallbackMessage, error);
  return res.status(500).json({ message: 'Internal server error.' });
};

router.post('/checkout', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  const vipPlanId = (process.env.SQUARE_VIP_PLAN_ID || '').trim();
  if (!vipPlanId) {
    return res.status(500).json({ message: 'VIP subscription plan is not configured.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user.squareCustomerId) {
      const customerResponse = await squareClient.customers.create({
        emailAddress: user.email,
        givenName: user.username,
        referenceId: user._id.toString(),
        note: 'ReemTeam VIP subscriber',
      });
      const customerId = customerResponse.customer?.id ?? null;
      if (customerId) {
        user.squareCustomerId = customerId;
        await user.save();
      }
    }

    const locationId = await resolveSquareLocationId();
    if (!locationId) {
      return res.status(500).json({ message: 'Square location is not configured or accessible for this access token.' });
    }

    const vipPriceCents = Number(process.env.SQUARE_VIP_PRICE_CENTS || '499');
    if (!Number.isFinite(vipPriceCents) || vipPriceCents <= 0) {
      return res.status(500).json({ message: 'VIP subscription price is not configured.' });
    }

    const frontendBaseUrl = FRONTEND_URL.replace(/\/$/, '');
    const checkoutResponse = await squareClient.checkout.paymentLinks.create({
      idempotencyKey: randomUUID(),
      description: `ReemTeam VIP subscription for ${user.username}`,
      quickPay: {
        name: 'ReemTeam VIP Membership',
        priceMoney: {
          amount: BigInt(Math.round(vipPriceCents)),
          currency: 'USD',
        },
        locationId,
      },
      checkoutOptions: {
        subscriptionPlanId: vipPlanId,
        redirectUrl: `${frontendBaseUrl}/account?paymentStatus=success&paymentType=vip`,
      },
      prePopulatedData: {
        buyerEmail: user.email,
      },
    });

    const checkoutUrl = checkoutResponse.paymentLink?.url;
    if (!checkoutUrl) {
      return res.status(500).json({
        message: 'Failed to create VIP subscription checkout link.',
        errors: checkoutResponse.errors ?? [],
      });
    }

    return res.status(200).json({ checkoutUrl });
  } catch (error: unknown) {
    return handleSquareError(res, error, 'Error creating VIP subscription checkout:');
  }
});

router.get('/status', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  const user = await User.findById(userId).select('vipStatus vipExpiresAt');
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.status(200).json(buildVipPayload(user));
});

export default router;
