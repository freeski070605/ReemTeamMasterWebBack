import { Schema, model, HydratedDocument, InferSchemaType } from 'mongoose';

const analyticsEventSchema = new Schema({
  name: {
    type: String,
    required: true,
    index: true,
    trim: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  sessionId: {
    type: String,
    trim: true,
  },
  path: {
    type: String,
    trim: true,
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

analyticsEventSchema.index({ name: 1, createdAt: -1 });

export type AnalyticsEvent = InferSchemaType<typeof analyticsEventSchema>;
export type AnalyticsEventDocument = HydratedDocument<AnalyticsEvent>;

export default model<AnalyticsEventDocument>('AnalyticsEvent', analyticsEventSchema);
