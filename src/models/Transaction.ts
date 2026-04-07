import { Schema, model, Types } from 'mongoose';

export interface ITransaction {
  userId: Types.ObjectId;
  type: 'Deposit' | 'Withdrawal' | 'Win' | 'Loss' | 'RtcPurchase' | 'RtcRefill' | 'RtcAnte' | 'RtcWin' | 'RtcEntry';
  amount: number;
  currency: 'USD' | 'RTC';
  status: 'Completed' | 'Pending' | 'Failed';
  date: Date;
  details?: {
    matchId?: Types.ObjectId;
    withdrawalRequestId?: Types.ObjectId;
    paymentId?: string;
    bundleId?: string;
    contestId?: string;
    reason?: string;
  };
}

const transactionSchema = new Schema<ITransaction>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['Deposit', 'Withdrawal', 'Win', 'Loss', 'RtcPurchase', 'RtcRefill', 'RtcAnte', 'RtcWin', 'RtcEntry'], required: true },
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['USD', 'RTC'], required: true },
  status: { type: String, enum: ['Completed', 'Pending', 'Failed'], required: true },
  date: { type: Date, default: Date.now },
  details: { type: Schema.Types.Mixed },
}, {
  timestamps: true,
});

export default model<ITransaction>('Transaction', transactionSchema);
