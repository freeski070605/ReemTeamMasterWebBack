import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User';
import Wallet from '../models/Wallet'; // Import Wallet model
import { generateToken } from '../utils/jwt';
import { ITokenPayload } from '../utils/jwt'; // Import ITokenPayload
import passport from 'passport';
import axios from 'axios';

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

router.post('/facebook/token', async (req: Request, res: Response) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ message: 'Access token is required.' });
    }

    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;

    if (!appId || !appSecret) {
      return res.status(500).json({ message: 'Facebook app credentials are not configured.' });
    }

    const appAccessToken = `${appId}|${appSecret}`;
    const debugResponse = await axios.get('https://graph.facebook.com/debug_token', {
      params: {
        input_token: accessToken,
        access_token: appAccessToken,
      },
    });

    if (!debugResponse.data?.data?.is_valid || debugResponse.data?.data?.app_id !== appId) {
      return res.status(401).json({ message: 'Invalid Facebook access token.' });
    }

    const profileResponse = await axios.get('https://graph.facebook.com/me', {
      params: {
        fields: 'id,name,email,picture',
        access_token: accessToken,
      },
    });

    const fbProfile = profileResponse.data;
    if (!fbProfile?.id) {
      return res.status(400).json({ message: 'Unable to fetch Facebook profile.' });
    }

    const fbEmail = fbProfile.email?.toLowerCase();
    const fbName = fbProfile.name?.trim() || 'Facebook User';
    const fbAvatar = fbProfile.picture?.data?.url;

    let user = await User.findOne({ 'socialProvider.id': fbProfile.id });

    if (!user && fbEmail) {
      user = await User.findOne({ email: fbEmail });
      if (user && !user.socialProvider?.id) {
        user.socialProvider = { name: 'facebook', id: fbProfile.id };
        if (fbAvatar && !user.avatarUrl) {
          user.avatarUrl = fbAvatar;
        }
        await user.save();
      }
    }

    if (!user) {
      const baseUsername = fbName.length >= 3 ? fbName : 'FacebookUser';
      let candidate = baseUsername;
      let suffix = 1;
      while (await User.exists({ username: candidate })) {
        suffix += 1;
        candidate = `${baseUsername}${suffix}`;
      }

      const email = fbEmail || `fb_${fbProfile.id}@facebook.local`;
      user = new User({
        username: candidate,
        email,
        avatarUrl: fbAvatar,
        socialProvider: {
          name: 'facebook',
          id: fbProfile.id,
        },
      });
      await user.save();

      const wallet = new Wallet({
        userId: user._id,
        availableBalance: 0,
        pendingWithdrawals: 0,
        lifetimeDeposits: 0,
        lifetimeWithdrawals: 0,
        matchEarningsHistory: [],
      });
      await wallet.save();
    }

    const tokenPayload: ITokenPayload = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
    };
    const token = generateToken(tokenPayload);

    res.json({
      token,
      userId: user._id,
      username: user.username,
      email: user.email,
    });
  } catch (error) {
    console.error('Facebook token login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
