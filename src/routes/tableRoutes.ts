import express from 'express';
import { randomBytes } from 'crypto';
import Table from '../models/Table';
import Invite from '../models/Invite';
import authMiddleware from '../middleware/auth';

const router = express.Router();

// GET /api/tables
router.get('/', async (req, res) => {
  try {
    const includePrivate = req.query.includePrivate === 'true';
    const query = includePrivate ? {} : { isPrivate: { $ne: true } };
    const tables = await Table.find(query).sort({ stake: 1 }); // Sort by stake, ascending
    res.json(tables);
  } catch (error) {
    console.error('Error fetching tables:', error);
    res.status(500).json({ message: 'Server error fetching tables' });
  }
});

// POST /api/tables/quick-seat
router.post('/quick-seat', async (req, res) => {
  try {
    const requestedMode = typeof req.body?.mode === 'string' ? req.body.mode : undefined;
    const modeFilter = requestedMode && requestedMode !== 'USD_CONTEST'
      ? { mode: requestedMode }
      : { mode: { $ne: 'USD_CONTEST' } };

    const tables = await Table.find({
      ...modeFilter,
      isPrivate: { $ne: true },
      $expr: { $lt: ['$currentPlayerCount', '$maxPlayers'] },
    });

    if (tables.length === 0) {
      return res.status(404).json({ message: 'No open tables available right now.' });
    }

    const sorted = [...tables].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'waiting' ? -1 : 1;
      if (a.currentPlayerCount !== b.currentPlayerCount) return b.currentPlayerCount - a.currentPlayerCount;
      return a.stake - b.stake;
    });

    const selected = sorted[0];
    return res.status(200).json({ tableId: selected._id, table: selected });
  } catch (error) {
    console.error('Error finding quick seat:', error);
    return res.status(500).json({ message: 'Server error finding quick seat.' });
  }
});

// POST /api/tables/private
router.post('/private', authMiddleware, async (req, res) => {
  try {
    const stake = Number(req.body?.stake);
    const maxPlayers = Number(req.body?.maxPlayers);

    if (!Number.isFinite(stake) || stake <= 0) {
      return res.status(400).json({ message: 'Invalid stake.' });
    }

    const resolvedMaxPlayers = Number.isFinite(maxPlayers) ? Math.min(Math.max(maxPlayers, 2), 4) : 4;
    const suffix = randomBytes(2).toString('hex').toUpperCase();
    const tableName = `Private Table ${suffix}`;

    const table = new Table({
      name: tableName,
      stake,
      mode: 'FREE_RTC_TABLE',
      minPlayers: 2,
      maxPlayers: resolvedMaxPlayers,
      currentPlayerCount: 0,
      players: [],
      status: 'waiting',
      isPrivate: true,
      createdBy: (req.user as any)?.id,
    });
    await table.save();

    const code = randomBytes(4).toString('hex');
    const invite = await Invite.create({
      code,
      purpose: 'table',
      tableId: table._id,
      createdBy: (req.user as any)?.id,
      maxUses: 0,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const inviteUrl = `${frontendBase}/invite/${invite.code}`;

    return res.status(201).json({ table, inviteCode: invite.code, inviteUrl });
  } catch (error) {
    console.error('Error creating private table:', error);
    return res.status(500).json({ message: 'Server error creating private table.' });
  }
});

export default router;
