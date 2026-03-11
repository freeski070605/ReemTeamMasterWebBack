import { Schema, model, HydratedDocument, InferSchemaType } from 'mongoose';

const recentPlayerSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  recentUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  recentUsername: {
    type: String,
    required: true,
    trim: true,
  },
  recentAvatarUrl: {
    type: String,
    default: null,
  },
  lastPlayedAt: {
    type: Date,
    required: true,
    index: true,
  },
}, {
  timestamps: true,
});

recentPlayerSchema.index({ userId: 1, recentUserId: 1 }, { unique: true });

export type RecentPlayer = InferSchemaType<typeof recentPlayerSchema>;
export type RecentPlayerDocument = HydratedDocument<RecentPlayer>;

export default model<RecentPlayerDocument>('RecentPlayer', recentPlayerSchema);
