import { Router, Request, Response } from 'express';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { verifyToken } from '../utils/jwt';
import authMiddleware from '../middleware/auth';
import requireAdmin from '../middleware/admin';

const router = Router();

const readBearerToken = (req: Request): string | null => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length).trim();
};

router.post('/events', async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ message: 'Event name is required.' });
    }

    const token = readBearerToken(req);
    const payload = token ? verifyToken(token) : null;
    const userId = payload?.id;

    const event = await AnalyticsEvent.create({
      name,
      userId,
      sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : undefined,
      path: typeof req.body?.path === 'string' ? req.body.path.trim() : undefined,
      metadata: typeof req.body?.metadata === 'object' ? req.body.metadata : undefined,
    });

    return res.status(201).json({ id: event._id });
  } catch (error) {
    console.error('[analytics] Failed to log event', error);
    return res.status(500).json({ message: 'Failed to log event.' });
  }
});

router.get('/summary', authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const totals = await AnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$name', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const daily = await AnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $project: {
          name: 1,
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        },
      },
      { $group: { _id: { day: '$day', name: '$name' }, count: { $sum: 1 } } },
      { $sort: { '_id.day': 1 } },
    ]);

    return res.status(200).json({
      since,
      totals,
      daily,
    });
  } catch (error) {
    console.error('[analytics] Failed to summarize events', error);
    return res.status(500).json({ message: 'Failed to summarize events.' });
  }
});

export default router;
