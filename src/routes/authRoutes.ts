import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import dotenv from 'dotenv';
import User from '../models/User';
import { generateToken } from '../utils/jwt';
import { ITokenPayload } from '../utils/jwt'; // Import ITokenPayload
import { ensureWalletForUser } from '../services/walletProvisioningService';

dotenv.config();

const router = Router();

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0)
);
const parsedResetTtlMinutes = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
const PASSWORD_RESET_TOKEN_TTL_MINUTES =
  Number.isFinite(parsedResetTtlMinutes) && parsedResetTtlMinutes > 0
    ? parsedResetTtlMinutes
    : 30;
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_RESET_REQUEST_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

const normalizeEmail = (value: unknown) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

const getFrontendBaseUrl = () => (
  (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')
);

const createPasswordResetToken = () => {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + (PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000));
  return { token, tokenHash, expiresAt };
};

const hashResetToken = (token: string) => (
  createHash('sha256').update(token).digest('hex')
);

// Register new user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);
    const isBootstrapAdmin = typeof normalizedEmail === 'string' && ADMIN_EMAILS.has(normalizedEmail);

    // Check if user already exists
    let user = await User.findOne({ $or: [{ username }, { email: normalizedEmail }] });
    if (user) {
      return res.status(400).json({ message: 'User with that username or email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create new user
    user = new User({
      username,
      email: normalizedEmail,
      passwordHash,
      isAdmin: isBootstrapAdmin,
    });
    await user.save();

    await ensureWalletForUser(user._id);

    // Generate JWT token
    const tokenPayload: ITokenPayload = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin ?? false,
    };
    const token = generateToken(tokenPayload);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      userId: user._id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin ?? false,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login user
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    // Check if user exists
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }
    if (!user.isAdmin && ADMIN_EMAILS.has(user.email.toLowerCase())) {
      user.isAdmin = true;
      await user.save();
    }

    // Check password
    if (!user.passwordHash) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    await ensureWalletForUser(user._id);

    // Generate JWT token
    const tokenPayload: ITokenPayload = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin ?? false,
    };
    const token = generateToken(tokenPayload);

    res.json({
      message: 'Logged in successfully',
      token,
      userId: user._id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin ?? false,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email);

    if (!normalizedEmail) {
      return res.status(200).json({ message: PASSWORD_RESET_REQUEST_MESSAGE });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (user && user.passwordHash) {
      const { token, tokenHash, expiresAt } = createPasswordResetToken();
      user.passwordResetTokenHash = tokenHash;
      user.passwordResetExpiresAt = expiresAt;
      await user.save();

      const resetLink = `${getFrontendBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[auth] Password reset link for ${normalizedEmail}: ${resetLink}`);
        return res.status(200).json({
          message: PASSWORD_RESET_REQUEST_MESSAGE,
          resetLink,
        });
      }

      console.log(
        `[auth] Password reset requested for ${normalizedEmail}. Configure email delivery for reset links.`
      );
    }

    return res.status(200).json({ message: PASSWORD_RESET_REQUEST_MESSAGE });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!token) {
      return res.status(400).json({ message: 'Reset token is required' });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      });
    }

    const tokenHash = hashResetToken(token);
    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Reset token is invalid or has expired' });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(password, salt);
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    return res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;
