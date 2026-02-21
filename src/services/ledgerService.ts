import { Types } from 'mongoose';
import LedgerEntry, {
  CurrencyCode,
  LedgerDirection,
  LedgerEventType,
  LedgerStatus,
} from '../models/LedgerEntry';
import { GameMode } from '../domain/gameMode';

export interface LedgerLogInput {
  userId?: string | Types.ObjectId | null;
  currency: CurrencyCode;
  mode?: GameMode;
  eventType: LedgerEventType;
  direction: LedgerDirection;
  amount: number;
  balanceAfter?: number;
  status?: LedgerStatus;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

const toObjectId = (value: string | Types.ObjectId): Types.ObjectId => {
  return value instanceof Types.ObjectId ? value : new Types.ObjectId(value);
};

export const logLedgerEntry = async (input: LedgerLogInput) => {
  const entry = new LedgerEntry({
    userId: input.userId ? toObjectId(input.userId) : undefined,
    currency: input.currency,
    mode: input.mode,
    eventType: input.eventType,
    direction: input.direction,
    amount: input.amount,
    balanceAfter: input.balanceAfter,
    status: input.status ?? 'completed',
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    metadata: input.metadata,
    occurredAt: input.occurredAt ?? new Date(),
  });

  await entry.save();
  return entry;
};

