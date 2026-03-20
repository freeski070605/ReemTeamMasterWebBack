import { Router } from 'express';
import { buildRgeFeed } from '../services/rgeFeedService';

const router = Router();

router.use((req, res, next) => {
  const configuredToken = (process.env.RGE_INTERNAL_TOKEN || '').trim();
  if (!configuredToken) {
    next();
    return;
  }

  const headerToken =
    (typeof req.headers['x-rge-token'] === 'string' ? req.headers['x-rge-token'] : '') ||
    (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length).trim()
      : '');

  if (headerToken !== configuredToken) {
    res.status(401).json({ message: 'Unauthorized RGE feed request.' });
    return;
  }

  next();
});

router.get('/feed', async (req, res) => {
  try {
    const days = Number(req.query.days ?? 30);
    const payload = await buildRgeFeed(days);
    res.status(200).json(payload);
  } catch (error) {
    console.error('[rge] Failed to build intelligence feed', error);
    res.status(500).json({ message: 'Failed to build RGE feed.' });
  }
});

export default router;
