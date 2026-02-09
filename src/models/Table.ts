import { Schema, model, Types, HydratedDocument, InferSchemaType } from 'mongoose';

interface ITablePlayer {
  userId: Types.ObjectId;
  isAI: boolean;
}

const playerSchema = new Schema<ITablePlayer>({
  userId: { type: Schema.Types.ObjectId, required: true },
  isAI: { type: Boolean, required: true }
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
}, {
  timestamps: true,
});

export interface ITable {
  name: string;
  stake: number;
  minPlayers: number;
  maxPlayers: number;
  currentPlayerCount: number;
  players: ITablePlayer[];
  status: 'waiting' | 'in-game';
  currentMatchId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type TableDocument = HydratedDocument<ITable>;

export default model<TableDocument>('Table', tableSchema);
