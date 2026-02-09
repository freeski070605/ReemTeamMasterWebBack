import { Router, Request, Response } from 'express';
import { ApiError, FRONTEND_URL, SQUARE_ENVIRONMENT } from '../utils/squareApi';
import { randomUUID } from 'crypto';
import Wallet from '../models/Wallet';
import authMiddleware from '../middleware/auth';
import mongoose from 'mongoose';

const router = Router();

import axios from 'axios';

router.post('/create-checkout', authMiddleware, async (req: Request, res: Response) => {
  const { amount } = req.body;
  console.log('user object from token:', req.user);
  const userId = (req.user as any)?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ message: 'Invalid amount provided.' });
  }

  try {
    const idempotencyKey = randomUUID();
    const locationId = process.env.SQUARE_LOCATION_ID;

    if (!locationId) {
      console.error('Square location ID is not set.');
      return res.status(500).json({ message: 'Server configuration error.' });
    }

    // 1. Create an Order
    const orderApiUrl = process.env.SQUARE_ENVIRONMENT === 'sandbox'
      ? 'https://connect.squareupsandbox.com/v2/orders'
      : 'https://connect.squareup.com/v2/orders';

    const orderResponse = await axios.post(
      orderApiUrl,
      {
        order: {
          location_id: locationId,
          line_items: [
            {
              name: `Wallet Deposit for User ${userId}`,
              quantity: "1",
              base_price_money: {
                amount: Math.round(amount * 100),
                currency: "USD",
              },
            },
          ],
          metadata: {
            userId,
          },
        },
        idempotency_key: idempotencyKey,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': '2023-10-18',
        },
      }
    );

    const order = orderResponse.data.order;

    if (!order || !order.id) {
      return res.status(500).json({ message: 'Failed to create Square order.' });
    }

    // 2. Create a Checkout Link via raw REST call
    const checkoutPayload = {
      idempotency_key: randomUUID(),
      order: {
        id: order.id,
        location_id: locationId,
      },
      checkout_options: {
        redirect_url: `${FRONTEND_URL}/wallet?paymentStatus=success&userId=${userId}&amount=${amount}`,
      },
       metadata: { // Pass metadata to the checkout as well
         userId,
       },
    };

    const squareApiUrl = process.env.SQUARE_ENVIRONMENT === 'sandbox'
      ? 'https://connect.squareupsandbox.com/v2/checkout'
      : 'https://connect.squareup.com/v2/checkout';

    const checkoutResponse = await axios.post(
      squareApiUrl,
      checkoutPayload,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const checkoutUrl = checkoutResponse.data.checkout?.checkout_page_url;

    if (checkoutUrl) {
      res.status(200).json({ checkoutUrl });
    } else {
      res.status(500).json({ message: 'Failed to create Square checkout link.' });
    }

  } catch (error: unknown) {
    if (error instanceof ApiError) {
      console.error('Square API Error:', error.errors);
      res.status(400).json({ message: 'Square API Error', errors: error.errors });
    } else if (axios.isAxiosError(error)) {
        console.error('Axios Error creating checkout:', error.response?.data);
        res.status(500).json({ message: 'Error creating checkout link.', details: error.response?.data });
    }
    else {
      console.error('Error creating checkout:', error);
      res.status(500).json({ message: 'Internal server error.' });
    }
  }
});

export default router;
