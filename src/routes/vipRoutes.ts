import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import authMiddleware from '../middleware/auth';
import User, { UserDocument } from '../models/User';
import { squareClient, ApiError, FRONTEND_URL } from '../utils/squareApi';
import { buildVipPayload, isVipActive, normalizeVipStatus, resolveVipExpiry } from '../utils/vip';

const router = Router();

const getVipPlanId = () => (process.env.SQUARE_VIP_PLAN_ID || '').trim();

const getVipPriceCents = (): number | null => {
  const vipPriceCents = Number(process.env.SQUARE_VIP_PRICE_CENTS || '499');
  if (!Number.isFinite(vipPriceCents) || vipPriceCents <= 0) {
    return null;
  }
  return Math.round(vipPriceCents);
};

const parseSubscriptionDate = (value?: string | null): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const pickSubscriptionCandidate = (subscriptions: any[]) => {
  if (!subscriptions.length) {
    return null;
  }

  const isCancelableStatus = (status?: string | null) => {
    const normalized = normalizeVipStatus(status ?? undefined);
    return normalized === 'ACTIVE' || normalized === 'PENDING' || normalized === 'PAUSED';
  };

  const byRecency = (a: any, b: any) => {
    const aScore = parseSubscriptionDate(a?.createdAt) || parseSubscriptionDate(a?.startDate);
    const bScore = parseSubscriptionDate(b?.createdAt) || parseSubscriptionDate(b?.startDate);
    return bScore - aScore;
  };

  const active = subscriptions.filter((subscription) => isCancelableStatus(subscription?.status));
  if (active.length > 0) {
    return [...active].sort(byRecency)[0];
  }

  return [...subscriptions].sort(byRecency)[0];
};

const resolveVipSubscriptionId = async (
  user: UserDocument,
  vipPlanId: string
): Promise<string | null> => {
  if (user.vipSubscriptionId) {
    return user.vipSubscriptionId;
  }

  if (!user.squareCustomerId) {
    return null;
  }

  const response = await squareClient.subscriptions.search({
    query: {
      filter: {
        customerIds: [user.squareCustomerId],
      },
    },
    limit: 25,
  });

  const subscriptions = (response.subscriptions ?? []).filter(
    (subscription) => subscription?.planVariationId === vipPlanId
  );
  const candidate = pickSubscriptionCandidate(subscriptions);
  if (candidate?.id) {
    user.vipSubscriptionId = candidate.id;
  }
  return candidate?.id ?? null;
};

const applySubscriptionToUser = (user: UserDocument, subscription: any) => {
  const status = normalizeVipStatus(subscription?.status ?? undefined);
  user.vipStatus = status;
  if (subscription?.id) {
    user.vipSubscriptionId = subscription.id;
  }

  const resolvedExpiry = resolveVipExpiry(subscription?.chargedThroughDate ?? null);
  if (resolvedExpiry) {
    user.vipExpiresAt = resolvedExpiry;
  }
  if (status === 'ACTIVE' && !user.vipSince) {
    user.vipSince = new Date();
  }
};

const syncVipStatusFromSquare = async (user: UserDocument, vipPlanId: string) => {
  if (!user.squareCustomerId) {
    return { synced: false };
  }

  const response = await squareClient.subscriptions.search({
    query: {
      filter: {
        customerIds: [user.squareCustomerId],
      },
    },
    limit: 25,
  });

  const subscriptions = (response.subscriptions ?? []).filter(
    (subscription) => subscription?.planVariationId === vipPlanId
  );
  const candidate = pickSubscriptionCandidate(subscriptions);
  if (!candidate) {
    return { synced: false };
  }

  applySubscriptionToUser(user, candidate);
  await user.save();
  return { synced: true };
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

  const vipPlanId = getVipPlanId();
  if (!vipPlanId) {
    return res.status(500).json({ message: 'VIP subscription plan is not configured.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (isVipActive(user.vipStatus, user.vipExpiresAt)) {
      return res.status(409).json({ message: 'VIP subscription is already active.' });
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

    const vipPriceCents = getVipPriceCents();
    if (!vipPriceCents) {
      return res.status(500).json({ message: 'VIP subscription price is not configured.' });
    }

    const frontendBaseUrl = FRONTEND_URL.replace(/\/$/, '');
    const checkoutResponse = await squareClient.checkout.paymentLinks.create({
      idempotencyKey: randomUUID(),
      description: `ReemTeam VIP subscription for ${user.username}`,
      quickPay: {
        name: 'ReemTeam VIP Membership',
        priceMoney: {
          amount: BigInt(vipPriceCents),
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

  const user = await User.findById(userId).select('vipStatus vipExpiresAt vipSince squareCustomerId');
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const shouldSync = req.query?.sync === 'true' || req.query?.sync === '1';
  let synced = false;
  if (shouldSync) {
    const vipPlanId = getVipPlanId();
    if (vipPlanId) {
      try {
        const syncResult = await syncVipStatusFromSquare(user, vipPlanId);
        synced = syncResult.synced;
      } catch (error) {
        console.warn('VIP status sync failed.', error);
      }
    }
  }

  const payload = buildVipPayload(user);
  return res.status(200).json({
    ...payload,
    vipSince: user.vipSince ?? null,
    synced,
  });
});

router.post('/sync', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  const vipPlanId = getVipPlanId();
  if (!vipPlanId) {
    return res.status(500).json({ message: 'VIP subscription plan is not configured.' });
  }

  try {
    const user = await User.findById(userId).select('vipStatus vipExpiresAt vipSince squareCustomerId');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const syncResult = await syncVipStatusFromSquare(user, vipPlanId);
    const payload = buildVipPayload(user);
    return res.status(200).json({
      ...payload,
      vipSince: user.vipSince ?? null,
      synced: syncResult.synced,
    });
  } catch (error: unknown) {
    return handleSquareError(res, error, 'Error syncing VIP status:');
  }
});

router.post('/cancel', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  const vipPlanId = getVipPlanId();
  if (!vipPlanId) {
    return res.status(500).json({ message: 'VIP subscription plan is not configured.' });
  }

  try {
    const user = await User.findById(userId).select(
      'vipStatus vipExpiresAt vipSince vipSubscriptionId squareCustomerId'
    );
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const subscriptionId = await resolveVipSubscriptionId(user, vipPlanId);
    if (!subscriptionId) {
      return res.status(404).json({ message: 'No active VIP subscription found to cancel.' });
    }

    const cancelResponse = await squareClient.subscriptions.cancel({ subscriptionId });
    if (cancelResponse.subscription) {
      applySubscriptionToUser(user, cancelResponse.subscription);
    }

    await user.save();
    const payload = buildVipPayload(user);
    return res.status(200).json({
      message: 'VIP cancellation scheduled.',
      ...payload,
      vipSince: user.vipSince ?? null,
    });
  } catch (error: unknown) {
    return handleSquareError(res, error, 'Error canceling VIP subscription:');
  }
});

export default router;
