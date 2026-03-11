import { Schema, model, HydratedDocument, InferSchemaType } from 'mongoose';

const inviteSchema = new Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
  },
  purpose: {
    type: String,
    enum: ['table', 'lobby'],
    required: true,
    default: 'table',
    index: true,
  },
  tableId: {
    type: Schema.Types.ObjectId,
    ref: 'Table',
    index: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  maxUses: {
    type: Number,
    default: 0, // 0 means unlimited
    min: 0,
  },
  uses: {
    type: Number,
    default: 0,
    min: 0,
  },
  usedBy: {
    type: [Schema.Types.ObjectId],
    ref: 'User',
    default: [],
  },
  lastUsedAt: {
    type: Date,
    default: null,
  },
  expiresAt: {
    type: Date,
    default: null,
    index: { expires: 0 },
  },
}, {
  timestamps: true,
});

inviteSchema.index({ code: 1, expiresAt: 1 });

export type Invite = InferSchemaType<typeof inviteSchema>;
export type InviteDocument = HydratedDocument<Invite>;

export default model<InviteDocument>('Invite', inviteSchema);
