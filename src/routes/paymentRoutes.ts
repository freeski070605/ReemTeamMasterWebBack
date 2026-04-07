import { Router, Request, Response } from 'express';
import { ApiError, FRONTEND_URL, squareClient } from '../utils/squareApi';
import { randomUUID } from 'crypto';
import authMiddleware from '../middleware/auth';
import { RTC_PURCHASE_BUNDLES, RtcPurchaseBundle } from '../config/economy';
import { isSquareAuthFailure, isSquareCatalogObjectNotFoundError } from '../utils/squareErrors';
import User from '../models/User';

const router = Router();
const CHECKOUT_DISPLAY_NAME_MAX_LENGTH = 60;

const buildSquareReferenceId = (
  rawUserId: unknown,
  prefix: 'wallet_deposit' | 'rtc_purchase' = 'wallet_deposit'
): string => {
  const userId = typeof rawUserId === 'string'
    ? rawUserId.trim()
    : String(rawUserId ?? '').trim();

  const directReference = `${prefix}:${userId}`;
  if (directReference.length <= 40) {
    return directReference;
  }

  // Square enforces a 40-char max on order.reference_id.
  const compactUserId = userId.replace(/[^a-fA-F0-9]/g, '').toLowerCase().slice(0, 24);
  if (compactUserId) {
    return `${prefix}:${compactUserId}`;
  }

  return `${prefix}:${randomUUID().replace(/-/g, '').slice(0, 24)}`;
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

const getAuthenticatedUserId = (req: Request): string => {
  const userId = (req.user as any)?.id;
  return typeof userId === 'string' ? userId.trim() : String(userId ?? '').trim();
};

const normalizeCheckoutDisplayName = (rawDisplayName: unknown): string => {
  if (typeof rawDisplayName !== 'string') {
    return '';
  }

  return rawDisplayName
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHECKOUT_DISPLAY_NAME_MAX_LENGTH);
};

const resolveCheckoutDisplayName = async (req: Request, userIdString: string): Promise<string> => {
  const tokenUsername = normalizeCheckoutDisplayName((req.user as any)?.username);
  if (tokenUsername) {
    return tokenUsername;
  }

  try {
    const user = await User.findById(userIdString).select('username').lean();
    const databaseUsername = normalizeCheckoutDisplayName(user?.username);
    if (databaseUsername) {
      return databaseUsername;
    }
  } catch (error) {
    console.warn(`Unable to resolve checkout username for user ${userIdString}.`, error);
  }

  return 'Player';
};

const getRtcBundle = (bundleId: string) => {
  return RTC_PURCHASE_BUNDLES.find((bundle) => bundle.id === bundleId) || null;
};

const buildRtcLineItem = (bundle: RtcPurchaseBundle, includeCatalogObjectId: boolean) => ({
  name: `${bundle.rtcAmount.toLocaleString('en-US')} RTC Bundle`,
  quantity: '1',
  basePriceMoney: {
    amount: BigInt(Math.round(bundle.usdPrice * 100)),
    currency: 'USD' as const,
  },
  ...(includeCatalogObjectId && bundle.squareCatalogObjectId
    ? { catalogObjectId: bundle.squareCatalogObjectId }
    : {}),
});

const createRtcPaymentLink = async (
  bundle: RtcPurchaseBundle,
  userIdString: string,
  checkoutDisplayName: string,
  locationId: string,
  frontendBaseUrl: string,
  includeCatalogObjectId: boolean
) => {
  return squareClient.checkout.paymentLinks.create({
    idempotencyKey: randomUUID(),
    order: {
      locationId,
      referenceId: buildSquareReferenceId(userIdString, 'rtc_purchase'),
      metadata: {
        userId: userIdString,
        username: checkoutDisplayName,
        purchaseType: 'rtc_bundle',
        bundleId: bundle.id,
      },
      lineItems: [buildRtcLineItem(bundle, includeCatalogObjectId)],
    },
    checkoutOptions: {
      redirectUrl: `${frontendBaseUrl}/account?paymentStatus=success&paymentType=rtc&bundleId=${encodeURIComponent(bundle.id)}`,
    },
    paymentNote: `RTC bundle ${bundle.id} purchase for ${checkoutDisplayName}`,
  });
};

const handleSquareError = (res: Response, error: unknown, fallbackMessage: string) => {
  if (error instanceof ApiError) {
    console.error('Square API Error:', error.errors);
    if (isSquareAuthFailure(error)) {
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

router.post('/create-checkout', authMiddleware, async (req: Request, res: Response) => {
  const { amount } = req.body;
  const userIdString = getAuthenticatedUserId(req);

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
    const checkoutDisplayName = await resolveCheckoutDisplayName(req, userIdString);
    const paymentLinkResponse = await squareClient.checkout.paymentLinks.create({
      idempotencyKey: randomUUID(),
      order: {
        locationId,
        referenceId: buildSquareReferenceId(userIdString),
        metadata: {
          userId: userIdString,
          username: checkoutDisplayName,
          purchaseType: 'usd_deposit',
        },
        lineItems: [
          {
            name: `Wallet Deposit for ${checkoutDisplayName}`,
            quantity: '1',
            basePriceMoney: {
              amount: BigInt(amountMinor),
              currency: 'USD',
            },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: `${frontendBaseUrl}/account?paymentStatus=success&paymentType=usd`,
      },
      paymentNote: `Wallet deposit for ${checkoutDisplayName}`,
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
    return handleSquareError(res, error, 'Error creating wallet checkout:');
  }
});

router.post('/create-rtc-checkout', authMiddleware, async (req: Request, res: Response) => {
  const { bundleId } = req.body ?? {};
  const userIdString = getAuthenticatedUserId(req);

  if (!userIdString) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  if (!bundleId || typeof bundleId !== 'string') {
    return res.status(400).json({ message: 'bundleId is required.' });
  }

  const bundle = getRtcBundle(bundleId);
  if (!bundle) {
    return res.status(400).json({ message: `Unknown RTC bundle: ${bundleId}.` });
  }

  try {
    const locationId = await resolveSquareLocationId();
    const frontendBaseUrl = FRONTEND_URL.replace(/\/$/, '');

    if (!locationId) {
      return res.status(500).json({ message: 'Square location is not configured or accessible for this access token.' });
    }

    const checkoutDisplayName = await resolveCheckoutDisplayName(req, userIdString);
    let paymentLinkResponse;
    try {
      paymentLinkResponse = await createRtcPaymentLink(
        bundle,
        userIdString,
        checkoutDisplayName,
        locationId,
        frontendBaseUrl,
        true
      );
    } catch (error) {
      if (bundle.squareCatalogObjectId && isSquareCatalogObjectNotFoundError(error)) {
        console.warn(
          `Square catalog object ${bundle.squareCatalogObjectId} is invalid for bundle ${bundle.id}. Retrying RTC checkout without catalogObjectId.`
        );
        paymentLinkResponse = await createRtcPaymentLink(
          bundle,
          userIdString,
          checkoutDisplayName,
          locationId,
          frontendBaseUrl,
          false
        );
      } else {
        throw error;
      }
    }

    const checkoutUrl = paymentLinkResponse.paymentLink?.url;

    if (checkoutUrl) {
      return res.status(200).json({ checkoutUrl });
    }

    return res.status(500).json({
      message: 'Failed to create Square RTC checkout link.',
      errors: paymentLinkResponse.errors ?? [],
    });
  } catch (error: unknown) {
    return handleSquareError(res, error, 'Error creating RTC checkout:');
  }
});

export default router;
