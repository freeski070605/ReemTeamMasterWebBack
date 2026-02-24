import { Router, Request, Response } from 'express';
import { ApiError, FRONTEND_URL, squareClient } from '../utils/squareApi';
import { randomUUID } from 'crypto';
import authMiddleware from '../middleware/auth';

const router = Router();

const buildSquareReferenceId = (rawUserId: unknown): string => {
  const userId = typeof rawUserId === 'string'
    ? rawUserId.trim()
    : String(rawUserId ?? '').trim();

  const directReference = `wallet_deposit:${userId}`;
  if (directReference.length <= 40) {
    return directReference;
  }

  // Square enforces a 40-char max on order.reference_id.
  const compactUserId = userId.replace(/[^a-fA-F0-9]/g, '').toLowerCase().slice(0, 24);
  if (compactUserId) {
    return `wallet_deposit:${compactUserId}`;
  }

  return `wallet_deposit:${randomUUID().replace(/-/g, '').slice(0, 24)}`;
};

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

router.post('/create-checkout', authMiddleware, async (req: Request, res: Response) => {
  const { amount } = req.body;
  const userId = (req.user as any)?.id;
  const userIdString = typeof userId === 'string' ? userId.trim() : String(userId ?? '').trim();

  if (!userIdString) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ message: 'Invalid amount provided.' });
  }

  try {
    const locationId = await resolveSquareLocationId();
    const frontendBaseUrl = FRONTEND_URL.replace(/\/$/, '');

    if (!locationId) {
      return res.status(500).json({ message: 'Square location is not configured or accessible for this access token.' });
    }

    const amountMinor = Math.round(amount * 100);
    const paymentLinkResponse = await squareClient.checkout.paymentLinks.create({
      idempotencyKey: randomUUID(),
      order: {
        locationId,
        referenceId: buildSquareReferenceId(userIdString),
        metadata: { userId: userIdString },
        lineItems: [
          {
            name: `Wallet Deposit for User ${userIdString}`,
            quantity: '1',
            basePriceMoney: {
              amount: BigInt(amountMinor),
              currency: 'USD',
            },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: `${frontendBaseUrl}/account?paymentStatus=success`,
      },
      paymentNote: `Wallet deposit for user ${userIdString}`,
    });

    const checkoutUrl = paymentLinkResponse.paymentLink?.url;

    if (checkoutUrl) {
      res.status(200).json({ checkoutUrl });
    } else {
      res.status(500).json({
        message: 'Failed to create Square checkout link.',
        errors: paymentLinkResponse.errors ?? [],
      });
    }

  } catch (error: unknown) {
    if (error instanceof ApiError) {
      console.error('Square API Error:', error.errors);
      const status = typeof error.statusCode === 'number' && error.statusCode >= 400
        ? error.statusCode
        : 502;
      res.status(status).json({ message: 'Square API Error', errors: error.errors });
    } else {
      console.error('Error creating checkout:', error);
      res.status(500).json({ message: 'Internal server error.' });
    }
  }
});

export default router;
