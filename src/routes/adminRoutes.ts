import { Request, Response, Router } from 'express';
import mongoose from 'mongoose';
import authMiddleware from '../middleware/auth';
import adminMiddleware from '../middleware/admin';
import Table from '../models/Table';
import Contest, { ContestDocument } from '../models/Contest';
import WithdrawalRequest from '../models/WithdrawalRequest';
import User from '../models/User';
import Wallet from '../models/Wallet';
import { GameMode } from '../domain/gameMode';
import { ContestService } from '../services/contestService';
import { redisClient } from '../config/redis';

const router = Router();

type ContestStatus = 'draft' | 'open' | 'locked' | 'in-progress' | 'completed' | 'cancelled';

const isGameMode = (value: unknown): value is GameMode =>
  typeof value === 'string' && Object.values(GameMode).includes(value as GameMode);

const isContestStatus = (value: unknown): value is ContestStatus =>
  typeof value === 'string'
  && ['draft', 'open', 'locked', 'in-progress', 'completed', 'cancelled'].includes(value);

const parseNumber = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a valid number.`);
  }
  return parsed;
};

const parsePositiveNumber = (value: unknown, field: string): number => {
  const parsed = parseNumber(value, field);
  if (parsed <= 0) {
    throw new Error(`${field} must be greater than 0.`);
  }
  return parsed;
};

const parseIntegerInRange = (
  value: unknown,
  field: string,
  min: number,
  max: number
): number => {
  const parsed = parseNumber(value, field);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
};

const findContestByAnyId = async (contestIdOrDbId: string): Promise<ContestDocument | null> => {
  const byContestId = await Contest.findOne({ contestId: contestIdOrDbId });
  if (byContestId) {
    return byContestId;
  }

  if (mongoose.Types.ObjectId.isValid(contestIdOrDbId)) {
    return Contest.findById(contestIdOrDbId);
  }

  return null;
};

router.use(authMiddleware, adminMiddleware);

router.get('/overview', async (_req: Request, res: Response) => {
  try {
    const [
      userCount,
      adminCount,
      walletCount,
      tableCount,
      cashCrownTableCount,
      contestCount,
      openContestCount,
      pendingWithdrawalCount,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ isAdmin: true }),
      Wallet.countDocuments({}),
      Table.countDocuments({}),
      Table.countDocuments({ mode: GameMode.USD_CONTEST }),
      Contest.countDocuments({}),
      Contest.countDocuments({ status: { $in: ['open', 'locked', 'in-progress'] } }),
      WithdrawalRequest.countDocuments({ status: 'pending' }),
    ]);

    return res.status(200).json({
      users: userCount,
      admins: adminCount,
      wallets: walletCount,
      tables: tableCount,
      cashCrownTables: cashCrownTableCount,
      contests: contestCount,
      activeContests: openContestCount,
      pendingWithdrawals: pendingWithdrawalCount,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch admin overview.' });
  }
});

router.get('/tables', async (req: Request, res: Response) => {
  try {
    const mode = req.query.mode;
    const query: Record<string, unknown> = {};

    if (mode !== undefined) {
      if (!isGameMode(mode)) {
        return res.status(400).json({ message: 'Invalid mode filter.' });
      }
      query.mode = mode;
    }

    const tables = await Table.find(query).sort({ mode: 1, stake: 1, name: 1, createdAt: 1 });
    return res.status(200).json(tables);
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch tables.' });
  }
});

router.post('/tables', async (req: Request, res: Response) => {
  try {
    const nameRaw = req.body?.name;
    if (typeof nameRaw !== 'string' || nameRaw.trim().length === 0) {
      return res.status(400).json({ message: 'name is required.' });
    }

    const stake = parsePositiveNumber(req.body?.stake, 'stake');
    const mode = isGameMode(req.body?.mode) ? req.body.mode : GameMode.USD_CONTEST;
    const minPlayers = req.body?.minPlayers !== undefined
      ? parseIntegerInRange(req.body.minPlayers, 'minPlayers', 2, 4)
      : 2;
    const maxPlayers = req.body?.maxPlayers !== undefined
      ? parseIntegerInRange(req.body.maxPlayers, 'maxPlayers', 2, 4)
      : 4;

    if (minPlayers > maxPlayers) {
      return res.status(400).json({ message: 'minPlayers cannot exceed maxPlayers.' });
    }

    const activeContestId = typeof req.body?.activeContestId === 'string'
      ? req.body.activeContestId.trim()
      : '';

    const table = new Table({
      name: nameRaw.trim(),
      stake,
      mode,
      minPlayers,
      maxPlayers,
      currentPlayerCount: 0,
      players: [],
      status: 'waiting',
      activeContestId: mode === GameMode.USD_CONTEST && activeContestId.length > 0 ? activeContestId : undefined,
    });

    await table.save();
    return res.status(201).json(table);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to create table.' });
  }
});

router.put('/tables/:tableId', async (req: Request, res: Response) => {
  try {
    const table = await Table.findById(req.params.tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (req.body?.name !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length === 0) {
        return res.status(400).json({ message: 'name must be a non-empty string.' });
      }
      table.name = req.body.name.trim();
    }

    if (req.body?.stake !== undefined) {
      table.stake = parsePositiveNumber(req.body.stake, 'stake');
    }

    if (req.body?.mode !== undefined) {
      if (!isGameMode(req.body.mode)) {
        return res.status(400).json({ message: 'Invalid mode.' });
      }
      table.mode = req.body.mode;
      if (req.body.mode !== GameMode.USD_CONTEST) {
        table.activeContestId = undefined;
      }
    }

    const minPlayers = req.body?.minPlayers !== undefined
      ? parseIntegerInRange(req.body.minPlayers, 'minPlayers', 2, 4)
      : table.minPlayers;
    const maxPlayers = req.body?.maxPlayers !== undefined
      ? parseIntegerInRange(req.body.maxPlayers, 'maxPlayers', 2, 4)
      : table.maxPlayers;

    if (minPlayers > maxPlayers) {
      return res.status(400).json({ message: 'minPlayers cannot exceed maxPlayers.' });
    }
    if (maxPlayers < table.currentPlayerCount) {
      return res.status(400).json({ message: 'maxPlayers cannot be lower than currentPlayerCount.' });
    }

    table.minPlayers = minPlayers;
    table.maxPlayers = maxPlayers;

    if (req.body?.activeContestId !== undefined) {
      if (table.mode !== GameMode.USD_CONTEST) {
        return res.status(400).json({ message: 'activeContestId can only be set for USD_CONTEST tables.' });
      }
      const nextContestId = typeof req.body.activeContestId === 'string' ? req.body.activeContestId.trim() : '';
      table.activeContestId = nextContestId.length > 0 ? nextContestId : undefined;
    }

    if (req.body?.status !== undefined) {
      if (req.body.status !== 'waiting') {
        return res.status(400).json({ message: 'Only status=waiting can be set manually. Use reset for live recovery.' });
      }
      table.status = 'waiting';
      table.currentMatchId = undefined;
    }

    await table.save();
    return res.status(200).json(table);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to update table.' });
  }
});

router.post('/tables/:tableId/reset', async (req: Request, res: Response) => {
  try {
    const table = await Table.findById(req.params.tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const keepContestBinding = req.body?.keepContestBinding === true;

    table.players = [];
    table.currentPlayerCount = 0;
    table.status = 'waiting';
    table.currentMatchId = undefined;
    if (!(keepContestBinding && table.mode === GameMode.USD_CONTEST)) {
      table.activeContestId = undefined;
    }
    await table.save();

    const tableId = table._id.toString();
    await redisClient.del(`table:${tableId}:players`);
    await redisClient.del(`table:${tableId}:players:leaving`);
    await redisClient.del(`game:${tableId}`);
    await redisClient.hSet(`table:${tableId}`, 'currentPlayerCount', '0');

    return res.status(200).json(table);
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to reset table.' });
  }
});

router.delete('/tables/:tableId', async (req: Request, res: Response) => {
  try {
    const table = await Table.findById(req.params.tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const force = req.query.force === 'true';
    if (table.currentPlayerCount > 0 && !force) {
      return res.status(409).json({ message: 'Table has seated players. Pass force=true to delete.' });
    }

    const tableId = table._id.toString();
    await Table.deleteOne({ _id: table._id });
    await redisClient.del(`table:${tableId}:players`);
    await redisClient.del(`table:${tableId}:players:leaving`);
    await redisClient.del(`game:${tableId}`);
    await redisClient.del(`table:${tableId}`);

    return res.status(200).json({ message: 'Table deleted.' });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to delete table.' });
  }
});

router.get('/contests', async (req: Request, res: Response) => {
  try {
    const status = req.query.status;
    if (status !== undefined && !isContestStatus(status)) {
      return res.status(400).json({ message: 'Invalid status filter.' });
    }

    const contests = await ContestService.listContests({
      mode: GameMode.USD_CONTEST,
      status: status as string | undefined,
    });
    return res.status(200).json(contests);
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to list contests.' });
  }
});

router.post('/contests', async (req: Request, res: Response) => {
  try {
    const contest = await ContestService.createContest({
      entryFee: parsePositiveNumber(req.body?.entryFee, 'entryFee'),
      playerCount: parseIntegerInRange(req.body?.playerCount, 'playerCount', 2, 4),
      platformFee: req.body?.platformFee !== undefined
        ? parseNumber(req.body.platformFee, 'platformFee')
        : undefined,
      payoutStructure: Array.isArray(req.body?.payoutStructure) ? req.body.payoutStructure : undefined,
    });
    return res.status(201).json(contest);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to create contest.' });
  }
});

router.patch('/contests/:contestId/status', async (req: Request, res: Response) => {
  try {
    const contestId = typeof req.params.contestId === 'string' ? req.params.contestId : '';
    const nextStatus = req.body?.status;
    if (!isContestStatus(nextStatus)) {
      return res.status(400).json({ message: 'status must be one of draft/open/locked/in-progress/cancelled.' });
    }

    if (nextStatus === 'completed') {
      return res.status(400).json({ message: 'Use match settlement to complete contests.' });
    }

    if (nextStatus === 'in-progress') {
      const started = await ContestService.startContest(contestId);
      return res.status(200).json(started);
    }

    const contest = await findContestByAnyId(contestId);
    if (!contest) {
      return res.status(404).json({ message: 'Contest not found.' });
    }

    if (contest.status === 'completed') {
      return res.status(400).json({ message: 'Completed contests cannot be modified.' });
    }

    if (nextStatus === 'open' && contest.participants.length >= contest.playerCount) {
      contest.status = 'locked';
    } else {
      contest.status = nextStatus;
    }

    if (nextStatus === 'cancelled') {
      contest.endedAt = new Date();
    } else {
      contest.endedAt = undefined;
    }

    contest.startedAt = undefined;

    await contest.save();
    return res.status(200).json(contest);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Failed to update contest status.' });
  }
});

export default router;
