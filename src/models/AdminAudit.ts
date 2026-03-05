import { Schema, model, HydratedDocument, InferSchemaType } from 'mongoose';
import { USER_ROLES } from '../constants/roles';

const adminAuditSchema = new Schema({
  adminUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  adminRole: {
    type: String,
    enum: USER_ROLES,
    required: true,
    index: true,
  },
  action: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  targetType: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  targetId: {
    type: String,
    trim: true,
  },
  beforeState: {
    type: Schema.Types.Mixed,
    default: null,
  },
  afterState: {
    type: Schema.Types.Mixed,
    default: null,
  },
  ipAddress: {
    type: String,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, {
  collection: 'adminAudits',
  versionKey: false,
});

adminAuditSchema.index({ createdAt: -1 });
adminAuditSchema.index({ adminUserId: 1, createdAt: -1 });
adminAuditSchema.index({ action: 1, createdAt: -1 });

export type IAdminAudit = InferSchemaType<typeof adminAuditSchema>;
export type AdminAuditDocument = HydratedDocument<IAdminAudit>;

export default model<AdminAuditDocument>('AdminAudit', adminAuditSchema);
