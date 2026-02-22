import { Router, Request, Response } from 'express';
import authMiddleware from '../middleware/auth';
import adminMiddleware from '../middleware/admin';
import { ITokenPayload } from '../utils/jwt';
import { ContestService } from '../services/contestService';
import Contest from '../models/Contest';

const router = Router();

const getParam = (value: string | string[]): string => {
  return Array.isArray(value) ? value[0] : value;
};

router.get('/', async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const contests = await ContestService.listContests({ status });
    return res.status(200).json(contests);
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to list contests.' });
  }
});

router.get('/:contestId', async (req: Request, res: Response) => {
  try {
    const contestId = getParam(req.params.contestId);
    const contest = await Contest.findOne({ contestId });
    if (!contest) {
      return res.status(404).json({ message: 'Contest not found.' });
    }
    return res.status(200).json(contest);
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch contest.' });
  }
});

router.post('/', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { entryFee, playerCount, platformFee, payoutStructure } = req.body ?? {};
    const contest = await ContestService.createContest({
      entryFee: Number(entryFee),
      playerCount: Number(playerCount),
      platformFee: platformFee !== undefined ? Number(platformFee) : undefined,
      payoutStructure: Array.isArray(payoutStructure) ? payoutStructure : undefined,
    });
    return res.status(201).json(contest);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to create contest.' });
  }
});

router.post('/:contestId/join', authMiddleware, async (req: Request, res: Response) => {
  const userId = (req.user as ITokenPayload)?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const joinMethod = req.body?.joinMethod === 'ticket' ? 'ticket' : 'usd';
    if (joinMethod === 'ticket') {
      const ticketId = req.body?.ticketId;
      if (!ticketId || typeof ticketId !== 'string') {
        return res.status(400).json({ message: 'ticketId is required when joinMethod=ticket.' });
      }

      const result = await ContestService.redeemTicketAndJoinContest({
        contestId: getParam(req.params.contestId),
        userId,
        ticketId,
      });

      return res.status(200).json({
        contest: result.contest,
        joinMethod,
        ticket: result.ticket,
      });
    }

    const result = await ContestService.joinContestWithUsd(getParam(req.params.contestId), userId);
    return res.status(200).json({
      contest: result.contest,
      alreadyJoined: result.alreadyJoined,
      joinMethod,
    });
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to join contest.' });
  }
});

router.post('/:contestId/start', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const contest = await ContestService.startContest(getParam(req.params.contestId));
    return res.status(200).json(contest);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to start contest.' });
  }
});

router.post('/:contestId/complete', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const placements = Array.isArray(req.body?.placements) ? req.body.placements : [];
    const result = await ContestService.completeContest({
      contestId: getParam(req.params.contestId),
      placements,
    });
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to complete contest.' });
  }
});

export default router;
