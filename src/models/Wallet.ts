import { Schema, model, Types, HydratedDocument, InferSchemaType } from 'mongoose';

const earningSchema = new Schema({
  matchId: { type: Schema.Types.ObjectId, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true }
}, { _id: false });

const walletSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  availableBalance: {
    type: Number,
    required: true,
    default: 25,
  },
  pendingWithdrawals: {
    type: Number,
    required: true,
    default: 0,
  },
  lifetimeDeposits: {
    type: Number,
    required: true,
    default: 0,
  },
  lifetimeWithdrawals: {
    type: Number,
    required: true,
    default: 0,
  },
  matchEarningsHistory: {
    type: [earningSchema],
    default: [],
  },
}, {
  timestamps: true,
});

export type IWallet = InferSchemaType<typeof walletSchema>;
export type WalletDocument = HydratedDocument<IWallet>;

export default model<WalletDocument>('Wallet', walletSchema);
