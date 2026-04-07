import mongoose from 'mongoose';
import dotenv from 'dotenv';
import connectDB from '../config/db';
import Wallet from '../models/Wallet';
import LedgerEntry from '../models/LedgerEntry';
import Transaction from '../models/Transaction';

dotenv.config();

const TOP_UP_AMOUNT = 5000;
const GRANT_REFERENCE_TYPE = 'system_grant';
const GRANT_REFERENCE_ID = 'existing-users-rtc-top-up-2026-04-07';

const grantExistingUsersRtcTopUp = async () => {
  await connectDB();

  let credited = 0;
  let skipped = 0;
  const cursor = Wallet.find().cursor();

  try {
    for await (const wallet of cursor) {
      const alreadyGranted = await LedgerEntry.exists({
        userId: wallet.userId,
        currency: 'RTC',
        eventType: 'SYSTEM_MINT',
        referenceType: GRANT_REFERENCE_TYPE,
        referenceId: GRANT_REFERENCE_ID,
      });

      if (alreadyGranted) {
        skipped += 1;
        continue;
      }

      wallet.rtcBalance += TOP_UP_AMOUNT;
      await wallet.save();

      await Transaction.create({
        userId: wallet.userId,
        type: 'RtcRefill',
        amount: TOP_UP_AMOUNT,
        currency: 'RTC',
        status: 'Completed',
        details: {
          reason: GRANT_REFERENCE_ID,
        },
      });

      await LedgerEntry.create({
        userId: wallet.userId,
        currency: 'RTC',
        eventType: 'SYSTEM_MINT',
        direction: 'credit',
        amount: TOP_UP_AMOUNT,
        balanceAfter: wallet.rtcBalance,
        referenceType: GRANT_REFERENCE_TYPE,
        referenceId: GRANT_REFERENCE_ID,
        metadata: {
          reason: 'existing_user_starting_balance_top_up',
        },
      });

      credited += 1;
    }

    console.log(`RTC top-up complete. Credited ${credited} wallet(s), skipped ${skipped} wallet(s).`);
  } finally {
    await mongoose.disconnect();
  }
};

grantExistingUsersRtcTopUp().catch(async (error) => {
  console.error('Failed to grant existing user RTC top-up:', error);
  await mongoose.disconnect();
  process.exit(1);
});
