import { Schema, model, HydratedDocument, InferSchemaType } from 'mongoose';
import { GameMode } from '../domain/gameMode';

const tournamentTicketSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  contestType: {
    type: String,
    required: true,
    trim: true,
  },
  targetMode: {
    type: String,
    enum: [GameMode.USD_CONTEST],
    required: true,
    default: GameMode.USD_CONTEST,
  },
  sourceMode: {
    type: String,
    enum: [GameMode.RTC_SATELLITE],
    required: true,
    default: GameMode.RTC_SATELLITE,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  used: {
    type: Boolean,
    required: true,
    default: false,
    index: true,
  },
  usedAt: {
    type: Date,
  },
  issuedFromContestId: {
    type: Schema.Types.ObjectId,
    ref: 'Contest',
  },
  issuedFromSessionId: {
    type: String,
    trim: true,
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

tournamentTicketSchema.index({ userId: 1, used: 1, expiresAt: 1 });

export type ITournamentTicket = InferSchemaType<typeof tournamentTicketSchema>;
export type TournamentTicketDocument = HydratedDocument<ITournamentTicket>;

export default model<TournamentTicketDocument>('TournamentTicket', tournamentTicketSchema);

