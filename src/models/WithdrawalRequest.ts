import { Schema, model, Types, HydratedDocument } from 'mongoose';

export interface IWithdrawalRequest {
  userId: Types.ObjectId;
  amount: number;
  payoutMethod: 'Cash App' | 'Apple Pay' | 'PayPal';
  payoutAddress: string;
  status: 'pending' | 'approved' | 'rejected' | 'fulfilled';
  requestedAt: Date;
  processedAt?: Date;
  transactionId?: string;
  processedBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

export type WithdrawalRequestDocument = HydratedDocument<IWithdrawalRequest>;

const withdrawalRequestSchema: Schema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01,
  },
  payoutMethod: {
    type: String,
    enum: ['Cash App', 'Apple Pay', 'PayPal'],
    required: true,
  },
  payoutAddress: {
    type: String,
    required: true,
    trim: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'fulfilled'],
    required: true,
    default: 'pending',
  },
  requestedAt: {
    type: Date,
    default: Date.now,
  },
  processedAt: {
    type: Date,
  },
  transactionId: {
    type: String,
  },
  processedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
} as any, {
  timestamps: true,
});

export default model<IWithdrawalRequest>('WithdrawalRequest', withdrawalRequestSchema);
