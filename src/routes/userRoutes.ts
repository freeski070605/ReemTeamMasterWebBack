import { Router, Request, Response } from 'express';
import multer from 'multer';
import User from '../models/User';
import authMiddleware from '../middleware/auth';

const router = Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/avatars');
  },
  filename: function (req: any, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, req.user.id + '-' + uniqueSuffix + '.' + file.mimetype.split('/')[1]);
  }
});

const upload = multer({ storage: storage });

router.post('/avatar/upload', authMiddleware, upload.single('avatar'), async (req: any, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    user.avatarUrl = '/' + req.file.path.replace(/\\\\/g, "/");;
    await user.save();

    res.json({ message: 'Avatar uploaded successfully.', avatarUrl: user.avatarUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/avatar/select-default', authMiddleware, async (req: any, res: Response) => {
  try {
    const { avatarUrl } = req.body;
    if (!avatarUrl) {
      return res.status(400).json({ message: 'No avatarUrl provided.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    user.avatarUrl = avatarUrl;
    await user.save();

    res.json({ message: 'Avatar updated successfully.', avatarUrl: user.avatarUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/link-social', authMiddleware, async (req: any, res: Response) => {
  try {
    const { provider, id } = req.body;
    if (!provider || !id) {
      return res.status(400).json({ message: 'Provider and id are required.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    user.socialProvider = {
      name: provider,
      id: id,
    };
    await user.save();

    res.json({ message: 'Social account linked successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
