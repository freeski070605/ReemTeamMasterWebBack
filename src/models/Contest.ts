import { Schema, model, HydratedDocument, InferSchemaType, Types } from 'mongoose';
import { GameMode } from '../domain/gameMode';

const payoutRuleSchema = new Schema({
  rank: { type: Number, required: true, min: 1 },
  amount: { type: Number, required: true, min: 0 },
  percentage: { type: Number, min: 0, max: 100 },
}, { _id: false });

const contestSchema = new Schema({
  contestId: {
    type: String,
    required: true,
    unique: true,
    default: () => new Types.ObjectId().toHexString(),
  },
  mode: {
    type: String,
    enum: [GameMode.USD_CONTEST],
    required: true,
    default: GameMode.USD_CONTEST,
  },
  entryFee: {
    type: Number,
    required: true,
    min: 0,
  },
  playerCount: {
    type: Number,
    required: true,
    min: 2,
    max: 4,
  },
  prizePool: {
    type: Number,
    required: true,
    min: 0,
  },
  platformFee: {
    type: Number,
    required: true,
    min: 0,
  },
  status: {
    type: String,
    enum: ['draft', 'open', 'locked', 'in-progress', 'completed', 'cancelled'],
    required: true,
    default: 'draft',
  },
  payoutStructure: {
    type: [payoutRuleSchema],
    default: [],
  },
  participants: {
    type: [Schema.Types.ObjectId],
    ref: 'User',
    default: [],
  },
  startedAt: {
    type: Date,
  },
  endedAt: {
    type: Date,
  },
}, {
  timestamps: true,
});

contestSchema.index({ status: 1, entryFee: 1 });

export type IContest = InferSchemaType<typeof contestSchema>;
export type ContestDocument = HydratedDocument<IContest>;

export default model<ContestDocument>('Contest', contestSchema);

