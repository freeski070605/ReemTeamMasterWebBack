import { Router, Request, Response } from 'express';
import { SquareClient, SquareEnvironment } from 'square';
import dotenv from 'dotenv';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import mongoose from 'mongoose';

dotenv.config();

const router = Router();

const SQUARE_WEBHOOK_SECRET = process.env.SQUARE_WEBHOOK_SECRET || '';
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000'; // Define BACKEND_URL

// Initialize Square client for API calls (though webhooks don't use it directly, good to have for validation)
const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: SQUARE_ENVIRONMENT,
});

router.post('/square-webhook', async (req: Request, res: Response) => {
  const signature = req.headers['x-square-signature'] as string;
  const url = BACKEND_URL + req.originalUrl; // Use BACKEND_URL
  const body = JSON.stringify(req.body);

  // TODO: Enable actual signature verification in production
  // if (!squareClient.webhook().verifySignature(body, signature, SQUARE_WEBHOOK_SECRET, url)) {
  //   return res.status(401).json({ message: 'Unauthorized: Invalid webhook signature.' });
  // }

  const { type, data } = req.body;

  if (type === 'payment.updated' && data.object.payment.status === 'COMPLETED') {
    const payment = data.object.payment;
    const orderId = payment.order_id; // Or from metadata if custom order ID was used
    const amountMoney = payment.amount_money;

    if (!amountMoney || !amountMoney.amount) {
      console.error('Webhook: Missing amount_money in payment.updated event.');
      return res.status(400).json({ message: 'Missing amount information.' });
    }

    const amount = Number(amountMoney.amount) / 100; // Convert cents to dollars
    // In a real scenario, you would have stored userId in the payment metadata when creating the payment link
    // For this example, let's assume userId is extracted from a custom field or a predefined value.
    console.log(`Square Webhook: Payment completed for order ${orderId}. Amount: ${amount} ${amountMoney.currency}`);

    const userIdFromMetadata = payment.metadata.userId; // Assuming metadata was passed
    if (!userIdFromMetadata) {
      console.warn('Square Webhook: No userId in payment metadata. Cannot credit wallet automatically.');
      return res.status(200).json({ message: 'Payment processed, but user wallet not credited due to missing userId in metadata.' });
    }

    try {
      const userObjectId = new mongoose.Types.ObjectId(userIdFromMetadata);
      const wallet = await Wallet.findOne({ userId: userObjectId });

      if (wallet) {
        wallet.availableBalance += amount;
        wallet.lifetimeDeposits += amount;
        // Add to matchEarningsHistory if this was a direct deposit into a match
        // For now, assuming general deposit
        await wallet.save();

        // Create a new transaction
        const transaction = new Transaction({
          userId: userObjectId,
          type: 'Deposit',
          amount: amount,
          status: 'Completed',
          details: {
            paymentId: payment.id,
          },
        });
        await transaction.save();

        console.log(`Wallet for user ${userIdFromMetadata} credited with ${amount} ${amountMoney.currency}.`);
      } else {
        console.error(`Square Webhook: Wallet not found for user ID: ${userIdFromMetadata}.`);
      }
    } catch (dbError: unknown) { // Explicitly type dbError as unknown
      console.error('Square Webhook: Database error updating wallet:', dbError);
      return res.status(500).json({ message: 'Internal server error during wallet update.' });
    }
  }

  res.status(200).json({ message: 'Webhook received and processed.' });
});

export default router;
