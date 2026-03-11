import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import User from '../models/User';
import RecentPlayer from '../models/RecentPlayer';
import authMiddleware from '../middleware/auth';

const router = Router();
const AVATAR_DIRECTORY = path.resolve(__dirname, '../../public/avatars');

fs.mkdirSync(AVATAR_DIRECTORY, { recursive: true });

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, AVATAR_DIRECTORY);
  },
  filename: function (req: Request, file, cb) {
    const userId = req.user?.id || 'unknown-user';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extFromName = path.extname(file.originalname || '').toLowerCase();
    const extFromMime = file.mimetype.split('/')[1];
    const extension = extFromName || (extFromMime ? `.${extFromMime}` : '.png');
    cb(null, `${userId}-${uniqueSuffix}${extension}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
      return;
    }

    cb(new Error('Only image uploads are allowed.'));
  },
});

const uploadAvatarHandler = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    if (!req.user?.id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    user.avatarUrl = `/avatars/${req.file.filename}`;
    await user.save();

    res.json({ message: 'Avatar uploaded successfully.', avatarUrl: user.avatarUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const selectDefaultAvatarHandler = async (req: Request, res: Response) => {
  try {
    const { avatarUrl } = req.body as { avatarUrl?: string };
    const normalizedAvatarUrl = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    const resolvedAvatarUrl = normalizedAvatarUrl
      .replace(/^\/avatars\/avatar([1-4])\.png$/i, '/avatars/avatar$1.svg')
      .replace(/^\/avatars\/default\.png$/i, '/avatars/default.svg');

    if (!normalizedAvatarUrl) {
      return res.status(400).json({ message: 'No avatarUrl provided.' });
    }

    if (!/^\/avatars\/avatar[1-4]\.svg$/i.test(resolvedAvatarUrl) && resolvedAvatarUrl !== '/avatars/default.svg') {
      return res.status(400).json({ message: 'Unsupported default avatar.' });
    }

    if (!req.user?.id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    user.avatarUrl = resolvedAvatarUrl;
    await user.save();

    res.json({ message: 'Avatar updated successfully.', avatarUrl: user.avatarUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

router.post('/avatar/upload', authMiddleware, upload.single('avatar'), uploadAvatarHandler);
router.post('/avatar', authMiddleware, upload.single('avatar'), uploadAvatarHandler);
router.post('/avatar/select-default', authMiddleware, selectDefaultAvatarHandler);
router.post('/avatar/default', authMiddleware, selectDefaultAvatarHandler);

router.get('/recent-players', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20) : 10;

    const recent = await RecentPlayer.find({ userId })
      .sort({ lastPlayedAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json(recent);
  } catch (error) {
    console.error('Failed to fetch recent players', error);
    return res.status(500).json({ message: 'Failed to fetch recent players.' });
  }
});

export default router;
