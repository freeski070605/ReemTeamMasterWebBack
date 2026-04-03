import { Schema, model, Types, HydratedDocument, InferSchemaType } from 'mongoose';
import { DEFAULT_GAME_MODE, GameMode } from '../domain/gameMode';

interface ITablePlayer {
  userId: Types.ObjectId;
  isAI: boolean;
  seat: number;
}

const playerSchema = new Schema<ITablePlayer>({
  userId: { type: Schema.Types.ObjectId, required: true },
  isAI: { type: Boolean, required: true },
  seat: { type: Number, required: true },
}, { _id: false });

const tableSchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  stake: {
    type: Number,
    required: true,
  },
  mode: {
    type: String,
    enum: Object.values(GameMode),
    required: true,
    default: DEFAULT_GAME_MODE,
  },
  isPrivate: {
    type: Boolean,
    required: true,
    default: false,
    index: true,
  },
  isPromo: {
    type: Boolean,
    required: true,
    default: false,
    index: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  hostNote: {
    type: String,
    trim: true,
    maxlength: 160,
  },
  minPlayers: {
    type: Number,
    required: true,
    default: 2,
  },
  maxPlayers: {
    type: Number,
    required: true,
    default: 4,
  },
  currentPlayerCount: {
    type: Number,
    required: true,
    default: 0,
  },
  players: {
    type: [playerSchema],
    default: [],
  },
  status: {
    type: String,
    enum: ['waiting', 'in-game'],
    required: true,
    default: 'waiting',
  },
  currentMatchId: {
    type: Schema.Types.ObjectId,
    ref: 'Match',
  },
  activeContestId: {
    type: String,
    trim: true,
    index: true,
  },
}, {
  timestamps: true,
});

export interface ITable {
  name: string;
  stake: number;
  mode: GameMode;
  isPrivate: boolean;
  isPromo: boolean;
  createdBy?: Types.ObjectId;
  hostNote?: string;
  minPlayers: number;
  maxPlayers: number;
  currentPlayerCount: number;
  players: ITablePlayer[];
  status: 'waiting' | 'in-game';
  currentMatchId?: Types.ObjectId;
  activeContestId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TableDocument = HydratedDocument<ITable>;

export default model<TableDocument>('Table', tableSchema);
