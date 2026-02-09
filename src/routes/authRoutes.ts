import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User';
import Wallet from '../models/Wallet'; // Import Wallet model
import { generateToken } from '../utils/jwt';
import { ITokenPayload } from '../utils/jwt'; // Import ITokenPayload
import passport from 'passport';

const router = Router();

// Register new user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;

    // Check if user already exists
    let user = await User.findOne({ $or: [{ username }, { email }] });
    if (user) {
      return res.status(400).json({ message: 'User with that username or email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create new user
    user = new User({
      username,
      email,
      passwordHash,
    });
    await user.save();

    // Create a new wallet for the user
    const wallet = new Wallet({
      userId: user._id,
      availableBalance: 0,
      pendingWithdrawals: 0,
      lifetimeDeposits: 0,
      lifetimeWithdrawals: 0,
      matchEarningsHistory: [],
    });
    await wallet.save();

    // Generate JWT token
    const tokenPayload: ITokenPayload = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
    };
    const token = generateToken(tokenPayload);

    res.status(201).json({ message: 'User registered successfully', token, userId: user._id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login user
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check password
    if (!user.passwordHash) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate JWT token
    const tokenPayload: ITokenPayload = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
    };
    const token = generateToken(tokenPayload);

    res.json({ message: 'Logged in successfully', token, userId: user._id, username: user.username, email: user.email });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Facebook Auth
router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));

router.get('/facebook/callback',
  passport.authenticate('facebook', { session: false }),
  (req: any, res) => {
    const tokenPayload: ITokenPayload = {
      id: req.user._id.toString(),
      username: req.user.username,
      email: req.user.email,
    };
    const token = generateToken(tokenPayload);
    res.json({ token });
  }
);

export default router;
