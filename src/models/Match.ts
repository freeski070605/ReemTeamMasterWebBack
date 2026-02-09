import { Schema, model, Types, HydratedDocument, InferSchemaType } from 'mongoose';

const actionSchema = new Schema({
  type: { type: String, required: true },
  details: { type: Schema.Types.Mixed },
  timestamp: { type: Date, required: true }
}, { _id: false });

const playerMatchStatsSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  username: { type: String, required: true },
  stake: { type: Number, required: true },
  buyIn: { type: Number, required: true },
  payout: { type: Number, required: true },
  isAI: { type: Boolean, required: true },
  finalHandValue: { type: Number },
  actions: { type: [actionSchema], default: [] }
}, { _id: false });

const matchLogItemSchema = new Schema({
  event: { type: String, required: true },
  details: { type: Schema.Types.Mixed },
  timestamp: { type: Date, required: true }
}, { _id: false });

const penaltySchema = new Schema({
  playerId: { type: Schema.Types.ObjectId, required: true },
  amount: { type: Number, required: true },
}, { _id: false });

const matchSchema = new Schema({
  tableId: {
    type: Schema.Types.ObjectId,
    ref: 'Table',
    required: true,
  },
  players: {
    type: [playerMatchStatsSchema],
    default: [],
  },
  winner: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  loser: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  winType: {
    type: String,
    enum: ['REEM', 'REGULAR', 'AUTO_TRIPLE', 'CAUGHT_DROP'],
    required: true,
  },
  pot: {
    type: Number,
    required: true,
  },
  winnerPayout: {
    type: Number,
    required: true,
  },
  penalties: {
    type: [penaltySchema],
    default: [],
  },
  roundNumber: {
    type: Number,
    required: true,
    default: 1,
  },
  status: {
    type: String,
    enum: ['in-progress', 'completed', 'cancelled'],
    required: true,
    default: 'in-progress',
  },
  startTime: {
    type: Date,
    default: Date.now,
  },
  endTime: {
    type: Date,
  },
  matchLog: {
    type: [matchLogItemSchema],
    default: [],
  },
}, {
  timestamps: true,
});

export type IMatch = InferSchemaType<typeof matchSchema>;
export type MatchDocument = HydratedDocument<IMatch>;

export default model<MatchDocument>('Match', matchSchema);
