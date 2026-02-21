import { Schema, model, HydratedDocument, InferSchemaType } from 'mongoose';
import { GameMode } from '../domain/gameMode';

export type CurrencyCode = 'USD' | 'RTC';
export type LedgerDirection = 'credit' | 'debit' | 'info';
export type LedgerStatus = 'pending' | 'completed' | 'failed';
export type LedgerEventType =
  | 'USD_DEPOSIT'
  | 'USD_WITHDRAWAL'
  | 'USD_CONTEST_ENTRY'
  | 'USD_PAYOUT_CREDIT'
  | 'USD_PRIZE_POOL_LOCK'
  | 'RTC_PURCHASE'
  | 'RTC_REFILL'
  | 'RTC_ANTE'
  | 'RTC_TOURNAMENT_ENTRY'
  | 'RTC_PRIZE_CREDIT'
  | 'RTC_BURN'
  | 'RTC_TICKET_ISSUED'
  | 'RTC_TICKET_REDEEMED'
  | 'SYSTEM_MINT'
  | 'SYSTEM_BURN';

const ledgerEntrySchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  currency: {
    type: String,
    enum: ['USD', 'RTC'],
    required: true,
    index: true,
  },
  mode: {
    type: String,
    enum: Object.values(GameMode),
    index: true,
  },
  eventType: {
    type: String,
    enum: [
      'USD_DEPOSIT',
      'USD_WITHDRAWAL',
      'USD_CONTEST_ENTRY',
      'USD_PAYOUT_CREDIT',
      'USD_PRIZE_POOL_LOCK',
      'RTC_PURCHASE',
      'RTC_REFILL',
      'RTC_ANTE',
      'RTC_TOURNAMENT_ENTRY',
      'RTC_PRIZE_CREDIT',
      'RTC_BURN',
      'RTC_TICKET_ISSUED',
      'RTC_TICKET_REDEEMED',
      'SYSTEM_MINT',
      'SYSTEM_BURN',
    ],
    required: true,
    index: true,
  },
  direction: {
    type: String,
    enum: ['credit', 'debit', 'info'],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  balanceAfter: {
    type: Number,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    required: true,
    default: 'completed',
    index: true,
  },
  referenceType: {
    type: String,
    trim: true,
  },
  referenceId: {
    type: String,
    trim: true,
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
  occurredAt: {
    type: Date,
    required: true,
    default: Date.now,
    index: true,
  },
}, {
  timestamps: true,
});

ledgerEntrySchema.index({ userId: 1, occurredAt: -1 });
ledgerEntrySchema.index({ currency: 1, occurredAt: -1 });

export type ILedgerEntry = InferSchemaType<typeof ledgerEntrySchema>;
export type LedgerEntryDocument = HydratedDocument<ILedgerEntry>;

export default model<LedgerEntryDocument>('LedgerEntry', ledgerEntrySchema);

