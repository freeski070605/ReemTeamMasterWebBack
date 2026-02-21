import { Router, Request, Response } from 'express';
import authMiddleware from '../middleware/auth';
import { ITokenPayload } from '../utils/jwt';
import { ContestService } from '../services/contestService';

const router = Router();

const getParam = (value: string | string[]): string => {
  return Array.isArray(value) ? value[0] : value;
};

router.get('/my', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const includeUsed = req.query.includeUsed === 'true';
    const tickets = await ContestService.getUserTickets(userId, { includeUsed });
    return res.status(200).json(tickets);
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch tickets.' });
  }
});

router.post('/:ticketId/redeem', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  const contestId = req.body?.contestId;
  if (!contestId || typeof contestId !== 'string') {
    return res.status(400).json({ message: 'contestId is required.' });
  }

  try {
    const result = await ContestService.redeemTicketAndJoinContest({
      contestId,
      userId,
      ticketId: getParam(req.params.ticketId),
    });
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to redeem ticket.' });
  }
});

export default router;
