import { Router, Request, Response } from 'express';
import Table from '../models/Table';
import { PresenceService } from '../services/presenceService';

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

export default router;
