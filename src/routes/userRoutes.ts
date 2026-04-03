import { Router, Request, Response } from 'express';
import multer from 'multer';
import User from '../models/User';
import RecentPlayer from '../models/RecentPlayer';
import authMiddleware from '../middleware/auth';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
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

    const updatedAt = new Date();
    user.avatarImageData = req.file.buffer;
    user.avatarImageContentType = req.file.mimetype || 'image/png';
    user.avatarImageUpdatedAt = updatedAt;
    user.avatarUrl = `/api/users/avatar/${user._id.toString()}?v=${updatedAt.getTime()}`;
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
    user.avatarImageData = null;
    user.avatarImageContentType = null;
    user.avatarImageUpdatedAt = null;
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
router.get('/avatar/:userId', async (req: Request, res: Response) => {
  try {
    const userId = typeof req.params.userId === 'string' ? req.params.userId.trim() : '';
    if (!userId) {
      return res.redirect(302, '/avatars/default.svg');
    }

    const user = await User.findById(userId)
      .select('avatarImageData avatarImageContentType avatarImageUpdatedAt');

    if (!user?.avatarImageData || !user?.avatarImageContentType) {
      return res.redirect(302, '/avatars/default.svg');
    }

    const avatarBuffer = Buffer.isBuffer(user.avatarImageData)
      ? user.avatarImageData
      : Buffer.from(user.avatarImageData);

    if (user.avatarImageUpdatedAt) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Last-Modified', new Date(user.avatarImageUpdatedAt).toUTCString());
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }

    res.setHeader('Content-Type', user.avatarImageContentType);
    return res.status(200).send(avatarBuffer);
  } catch (error) {
    console.error('Failed to serve avatar image', error);
    return res.redirect(302, '/avatars/default.svg');
  }
});

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
