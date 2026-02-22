import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
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

// Register new user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;
    const normalizedEmail = typeof email === 'string' ? email.toLowerCase() : '';
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
    const normalizedEmail = typeof email === 'string' ? email.toLowerCase() : '';

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
      isAdmin: user.isAdmin ?? false,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
