import { Schema, model, Types } from 'mongoose';

export interface ITransaction {
  userId: Types.ObjectId;
  type: 'Deposit' | 'Withdrawal' | 'Win' | 'Loss';
  amount: number;
  status: 'Completed' | 'Pending' | 'Failed';
  date: Date;
  details?: {
    matchId?: Types.ObjectId;
    withdrawalRequestId?: Types.ObjectId;
    paymentId?: string;
  };
}

const transactionSchema = new Schema<ITransaction>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['Deposit', 'Withdrawal', 'Win', 'Loss'], required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['Completed', 'Pending', 'Failed'], required: true },
  date: { type: Date, default: Date.now },
  details: { type: Schema.Types.Mixed },
}, {
  timestamps: true,
});

export default model<ITransaction>('Transaction', transactionSchema);
