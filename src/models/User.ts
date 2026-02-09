import { Schema, model, HydratedDocument, InferSchemaType } from 'mongoose';

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
    required: function() {
      return !(this as any).socialProvider;
    },
  },
  avatarUrl: {
    type: String,
    default: '/avatars/default.png',
  },
  socialProvider: {
    name: String,
    id: String,
  },
}, {
  timestamps: true,
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
