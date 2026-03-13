import { Schema, model, HydratedDocument, InferSchemaType } from 'mongoose';
import { USER_ROLES, resolveUserRole, isAdminRole } from '../constants/roles';

const userSchema = new Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  passwordHash: {
    type: String,
    // Keep legacy records savable if they predate credential-only auth.
    required: function() {
      return this.isNew || !!(this as any).passwordHash;
    },
  },
  passwordResetTokenHash: {
    type: String,
    default: null,
  },
  passwordResetExpiresAt: {
    type: Date,
    default: null,
  },
  avatarUrl: {
    type: String,
    default: '/avatars/default.svg',
  },
  vipStatus: {
    type: String,
    enum: ['NONE', 'PENDING', 'ACTIVE', 'PAUSED', 'CANCELED', 'DEACTIVATED', 'COMPLETED'],
    default: 'NONE',
    index: true,
  },
  vipSince: {
    type: Date,
    default: null,
  },
  vipExpiresAt: {
    type: Date,
    default: null,
  },
  vipSubscriptionId: {
    type: String,
    default: null,
    index: true,
  },
  squareCustomerId: {
    type: String,
    default: null,
    index: true,
  },
  role: {
    type: String,
    enum: USER_ROLES,
    required: true,
    default: 'user',
    index: true,
  },
  isBanned: {
    type: Boolean,
    required: true,
    default: false,
    index: true,
  },
  isFrozen: {
    type: Boolean,
    required: true,
    default: false,
    index: true,
  },
  adminNotes: {
    type: [String],
    default: [],
  },
  isAdmin: {
    type: Boolean,
    required: true,
    default: false,
  },
}, {
  timestamps: true,
});

userSchema.pre('validate', function syncLegacyRoleFields() {
  const user = this as any;
  user.role = resolveUserRole(user.role, !!user.isAdmin);
  user.isAdmin = isAdminRole(user.role);

  if (!Array.isArray(user.adminNotes)) {
    user.adminNotes = [];
  }
});

userSchema.virtual('id').get(function() {
  return this._id.toHexString();
});

// Ensure virtuals are included in toJSON outputs
userSchema.set('toJSON', {
  virtuals: true
});

export type IUser = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<IUser>;

export default model<UserDocument>('User', userSchema);
