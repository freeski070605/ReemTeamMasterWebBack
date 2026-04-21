import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import authMiddleware from '../middleware/auth';
import Match from '../models/Match';
import Table from '../models/Table';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { PresenceService } from '../services/presenceService';
import {
  QuickPlayTableCandidate,
  getQuickPlayCandidates,
  getQuickPlayReason,
  isBeginnerFriendlyTable,
  pickQuickPlayTable,
} from '../services/quickPlayService';

const router = Router();

router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const tables = await Table.find({ isPrivate: { $ne: true } })
      .select('status maxPlayers currentPlayerCount mode stake')
      .lean();

    const activeTables = tables.filter((table) => table.status === 'in-game').length;
    const openSeats = tables.reduce((sum, table) => sum + Math.max(0, table.maxPlayers - table.currentPlayerCount), 0);
    const rtcTables = tables.filter((table) => table.mode !== 'USD_CONTEST').length;
    const usdTables = tables.filter((table) => table.mode === 'USD_CONTEST').length;
    const onlinePlayers = await PresenceService.getOnlineCount();

    return res.status(200).json({
      onlinePlayers,
      activeTables,
      openSeats,
      rtcTables,
      usdTables,
      totalTables: tables.length,
    });
  } catch (error) {
    console.error('[lobby] Failed to fetch summary', error);
    return res.status(500).json({ message: 'Failed to fetch lobby summary.' });
  }
});

router.get('/activation', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);
    const [tables, matchesPlayed, lastCompletedMatch, lastStartedEvent, onlinePlayers] = await Promise.all([
      Table.find({ isPrivate: { $ne: true }, isPromo: { $ne: true } })
        .select('name stake mode isPrivate isPromo minPlayers maxPlayers currentPlayerCount status players')
        .lean(),
      Match.countDocuments({
        status: 'completed',
        'players.userId': userObjectId,
      }),
      Match.findOne({
        status: 'completed',
        'players.userId': userObjectId,
      })
        .sort({ endTime: -1, createdAt: -1 })
        .select('endTime createdAt')
        .lean(),
      AnalyticsEvent.findOne({
        userId: userObjectId,
        name: { $in: ['first_game_started', 'game_start', 'table_joined'] },
      })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean(),
      PresenceService.getOnlineCount(),
    ]);

    const publicCribTables = tables.filter((table) => table.mode !== 'USD_CONTEST') as QuickPlayTableCandidate[];
    const openSeats = publicCribTables.reduce(
      (sum, table) => sum + Math.max(0, Number(table.maxPlayers ?? 0) - Number(table.currentPlayerCount ?? 0)),
      0
    );
    const beginnerMode = matchesPlayed === 0 && !lastStartedEvent;
    const quickPlay = pickQuickPlayTable(publicCribTables, { beginnerMode });
    const recommendedTables = getQuickPlayCandidates(publicCribTables, { beginnerMode })
      .slice(0, 3)
      .map((table) => ({
        table,
        reason: getQuickPlayReason(table),
        beginnerFriendly: isBeginnerFriendlyTable(table),
      }));

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      summary: {
        onlinePlayers,
        activeTables: publicCribTables.filter((table) => table.status === 'in-game').length,
        openSeats,
        rtcTables: publicCribTables.length,
        usdTables: tables.filter((table) => table.mode === 'USD_CONTEST').length,
        totalTables: tables.length,
      },
      playerState: {
        matchesPlayed,
        hasPlayedGame: matchesPlayed > 0 || !!lastStartedEvent,
        hasCompletedGame: matchesPlayed > 0,
        lastStartedAt: lastStartedEvent?.createdAt ?? null,
        lastCompletedAt: lastCompletedMatch?.endTime ?? lastCompletedMatch?.createdAt ?? null,
      },
      quickPlay: quickPlay.table && quickPlay.reason
        ? {
            table: quickPlay.table,
            reason: quickPlay.reason,
            beginnerFriendly: quickPlay.beginnerFriendly,
          }
        : null,
      recommendedTables,
    });
  } catch (error) {
    console.error('[lobby] Failed to fetch activation state', error);
    return res.status(500).json({ message: 'Failed to fetch activation state.' });
  }
});

export default router;
