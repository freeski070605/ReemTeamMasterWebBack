import { Request, Response, Router } from 'express';
import mongoose from 'mongoose';
import authMiddleware from '../middleware/auth';
import {
  getAuthenticatedAdminUser,
  requireAdmin,
  requireFinance,
  requireSuperAdmin,
} from '../middleware/admin';
import { adminRateLimiter } from '../middleware/adminRateLimit';
import { auditLogger } from '../middleware/auditLogger';
import User from '../models/User';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import WithdrawalRequest from '../models/WithdrawalRequest';
import Table from '../models/Table';
import Match from '../models/Match';
import Contest from '../models/Contest';
import AdminAudit from '../models/AdminAudit';
import { ensureWalletForUser } from '../services/walletProvisioningService';
import { loadGameState } from '../game/gameEngine';
import { logLedgerEntry } from '../services/ledgerService';
import { redisClient } from '../config/redis';
import { USER_ROLES, isUserRole, resolveUserRole, roleAtLeast } from '../constants/roles';
import { GameMode } from '../domain/gameMode';

const router = Router();

const MAX_USER_SEARCH_RESULTS = 50;
const MAX_ADMIN_NOTE_LENGTH = 500;
const MAX_BALANCE_ADJUSTMENT = 100_000;
const TABLE_STATUS_FILTERS = ['all', 'in-game', 'waiting'] as const;
const ADMIN_WALLET_ADJUST_CURRENCIES = ['USD', 'RTC'] as const;
const PROMO_TABLE_NAME = 'Promo Content Table';
const PROMO_AI_NAMES = ['Promo Ace', 'Promo Blaze', 'Promo Cash', 'Promo Drift'] as const;

type TableStatusFilter = typeof TABLE_STATUS_FILTERS[number];
type AdminWalletAdjustCurrency = typeof ADMIN_WALLET_ADJUST_CURRENCIES[number];

const isObjectId = (value: string): boolean => mongoose.Types.ObjectId.isValid(value);

const toObjectId = (value: string): mongoose.Types.ObjectId => new mongoose.Types.ObjectId(value);

const getRouteParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
};

const buildUserSearchQuery = (query: string) => {
  if (!query) {
    return {};
  }

  return {
    $or: [
      { username: { $regex: query, $options: 'i' } },
      { email: { $regex: query, $options: 'i' } },
    ],
  };
};

const isTableStatusFilter = (value: unknown): value is TableStatusFilter => {
  return typeof value === 'string' && TABLE_STATUS_FILTERS.includes(value as TableStatusFilter);
};

const isAdminWalletAdjustCurrency = (value: unknown): value is AdminWalletAdjustCurrency => {
  return typeof value === 'string' && ADMIN_WALLET_ADJUST_CURRENCIES.includes(value as AdminWalletAdjustCurrency);
};

const toSafeAmount = (value: unknown, field: string): number => {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) {
    throw new Error(`${field} must be a valid number.`);
  }
  return Math.round(amount * 100) / 100;
};

const maskPayoutAddress = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(Math.max(trimmed.length - 4, 4))}${trimmed.slice(-4)}`;
};

const toPagination = (req: Request) => {
  const pageRaw = Number(req.query.page);
  const limitRaw = Number(req.query.limit);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, 100)
    : 20;
  return { page, limit, skip: (page - 1) * limit };
};

const serializeUser = (user: any) => ({
  id: user._id.toString(),
  username: user.username,
  email: user.email,
  avatarUrl: user.avatarUrl ?? null,
  role: resolveUserRole(user.role, !!user.isAdmin),
  isBanned: !!user.isBanned,
  isFrozen: !!user.isFrozen,
  adminNotes: Array.isArray(user.adminNotes) ? user.adminNotes : [],
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const serializeWallet = (wallet: any) => ({
  userId: wallet.userId?.toString?.() ?? wallet.userId,
  usdBalance: wallet.usdBalance,
  rtcBalance: wallet.rtcBalance,
  pendingWithdrawals: wallet.pendingWithdrawals,
  lifetimeDeposits: wallet.lifetimeDeposits,
  lifetimeWithdrawals: wallet.lifetimeWithdrawals,
  lastRtcRefill: wallet.lastRtcRefill,
  updatedAt: wallet.updatedAt,
});

const serializeWithdrawal = (request: any) => ({
  id: request._id.toString(),
  userId: typeof request.userId === 'object' ? request.userId?._id?.toString?.() : request.userId?.toString?.(),
  username: typeof request.userId === 'object' ? request.userId?.username : undefined,
  email: typeof request.userId === 'object' ? request.userId?.email : undefined,
  amount: request.amount,
  payoutMethod: request.payoutMethod,
  payoutAddressMasked: maskPayoutAddress(request.payoutAddress || ''),
  status: request.status,
  requestedAt: request.requestedAt,
  processedAt: request.processedAt,
  transactionId: request.transactionId,
  processedBy: request.processedBy?.toString?.(),
});

const serializeAdminTable = async (table: any) => {
  const tableId = table._id.toString();
  const gameState = await loadGameState(tableId);
  const currentPlayer = gameState?.players?.[gameState.currentPlayerIndex];
  const turnTimeRemainingMs = gameState
    ? Math.max(0, (gameState.turnExpiresAt ?? Date.now()) - Date.now())
    : null;

  return {
    tableId,
    name: table.name,
    mode: table.mode,
    stake: table.stake,
    status: table.status,
    isPromo: !!table.isPromo,
    minPlayers: table.minPlayers,
    maxPlayers: table.maxPlayers,
    currentPlayerCount: table.currentPlayerCount,
    activeContestId: table.activeContestId ?? null,
    currentMatchId: table.currentMatchId?.toString?.() ?? null,
    playersSeated: gameState
      ? gameState.players.map((player) => ({
          userId: player.userId,
          username: player.username,
          isAI: player.isAI,
        }))
      : table.players.map((player: any, index: number) => ({
          userId: player.userId.toString(),
          username: player.isAI
            ? (table.isPromo ? PROMO_AI_NAMES[index] ?? `AI_${player.userId.toString().slice(-4)}` : `AI_${player.userId.toString().slice(-4)}`)
            : `User_${player.userId.toString().slice(-6)}`,
          isAI: player.isAI,
        })),
    currentPot: gameState?.pot ?? null,
    turnState: gameState
      ? {
          status: gameState.status,
          turn: gameState.turn,
          currentPlayerId: currentPlayer?.userId ?? null,
          currentPlayerUsername: currentPlayer?.username ?? null,
          turnExpiresAt: gameState.turnExpiresAt ?? null,
          turnTimeRemainingMs,
        }
      : null,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt,
  };
};

const appendAdminNote = (user: any, note: string | undefined, actorName: string) => {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (!trimmed) {
    return;
  }

  const safeNote = trimmed.slice(0, MAX_ADMIN_NOTE_LENGTH);
  const stamped = `[${new Date().toISOString()}][${actorName}] ${safeNote}`;
  const existing = Array.isArray(user.adminNotes) ? user.adminNotes : [];
  user.adminNotes = [...existing, stamped].slice(-100);
};

const resetTableRuntimeState = async (
  table: any,
  keepContestBinding: boolean
) => {
  table.players = [];
  table.currentPlayerCount = 0;
  table.status = 'waiting';
  table.currentMatchId = undefined;
  if (!(keepContestBinding && table.mode === 'USD_CONTEST')) {
    table.activeContestId = undefined;
  }
  await table.save();

  const tableId = table._id.toString();
  await redisClient.del(`table:${tableId}:players`);
  await redisClient.del(`table:${tableId}:players:leaving`);
  await redisClient.del(`game:${tableId}`);
  await redisClient.hSet(`table:${tableId}`, 'currentPlayerCount', '0');
};

const buildPromoAiPlayers = (table: any) => {
  const existingAiIds = Array.isArray(table.players)
    ? table.players
        .filter((player: any) => player?.isAI && player?.userId)
        .map((player: any) => player.userId.toString())
    : [];

  return PROMO_AI_NAMES.map((username, index) => ({
    userId: existingAiIds[index] ?? new mongoose.Types.ObjectId().toString(),
    username,
    isAI: true,
    avatarUrl: null as string | null,
  }));
};

const seedPromoTableState = async (table: any) => {
  const aiPlayers = buildPromoAiPlayers(table);
  table.name = PROMO_TABLE_NAME;
  table.mode = GameMode.FREE_RTC_TABLE;
  table.isPrivate = true;
  table.isPromo = true;
  table.minPlayers = 4;
  table.maxPlayers = 4;
  table.players = aiPlayers.map((player) => ({
    userId: new mongoose.Types.ObjectId(player.userId),
    isAI: true,
  }));
  table.currentPlayerCount = aiPlayers.length;
  table.status = 'waiting';
  table.currentMatchId = undefined;
  table.activeContestId = undefined;
  await table.save();

  await redisClient.del(`table:${table._id}:players`);
  await redisClient.del(`table:${table._id}:players:leaving`);
  await Promise.all(
    aiPlayers.map((player) =>
      redisClient.hSet(
        `table:${table._id}:players`,
        player.userId,
        JSON.stringify({
          username: player.username,
          isAI: true,
          avatarUrl: null,
        })
      )
    )
  );
  await redisClient.hSet(`table:${table._id}`, 'currentPlayerCount', String(aiPlayers.length));

  return table;
};

router.use(authMiddleware);
router.use(adminRateLimiter);

router.get('/users/search', requireAdmin, async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const query = buildUserSearchQuery(q);

    const users = await User.find(query)
      .select('username email avatarUrl role isAdmin isBanned isFrozen adminNotes createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(MAX_USER_SEARCH_RESULTS);

    return res.status(200).json({
      query: q,
      total: users.length,
      users: users.map(serializeUser),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to search users.' });
  }
});

router.get('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = getRouteParam(req.params.id);
    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid user id.' });
    }

    const user = await User.findById(id)
      .select('username email avatarUrl role isAdmin isBanned isFrozen adminNotes createdAt updatedAt');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const [wallet, transactions] = await Promise.all([
      ensureWalletForUser(id),
      Transaction.find({ userId: toObjectId(id) }).sort({ date: -1 }).limit(100),
    ]);

    return res.status(200).json({
      user: serializeUser(user),
      wallet: serializeWallet(wallet),
      transactions,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to load user profile.' });
  }
});

router.patch(
  '/users/:id/ban',
  requireAdmin,
  auditLogger({
    action: 'user.ban.toggle',
    targetType: 'user',
    resolveTargetId: (req) => getRouteParam(req.params.id),
    captureBefore: async (req) => {
      const targetId = getRouteParam(req.params.id);
      if (!isObjectId(targetId)) return null;
      const user = await User.findById(targetId)
        .select('role isBanned isFrozen adminNotes updatedAt');
      return user
        ? {
            role: resolveUserRole(user.role, !!user.isAdmin),
            isBanned: user.isBanned,
            isFrozen: user.isFrozen,
            adminNotesCount: (user.adminNotes || []).length,
            updatedAt: user.updatedAt,
          }
        : null;
    },
    captureAfter: (_req, res) => res.locals.auditAfterState ?? null,
  }),
  async (req: Request, res: Response) => {
    try {
      const id = getRouteParam(req.params.id);
      if (!isObjectId(id)) {
        return res.status(400).json({ message: 'Invalid user id.' });
      }

      const actor = await getAuthenticatedAdminUser(req);
      if (!actor) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      const user = await User.findById(id)
        .select('username email avatarUrl role isAdmin isBanned isFrozen adminNotes createdAt updatedAt');
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      const requested = req.body?.isBanned;
      const nextIsBanned = typeof requested === 'boolean' ? requested : !user.isBanned;
      user.isBanned = nextIsBanned;
      appendAdminNote(user, req.body?.note, actor.username);
      await user.save();

      const payload = serializeUser(user);
      res.locals.auditAfterState = {
        role: payload.role,
        isBanned: payload.isBanned,
        isFrozen: payload.isFrozen,
        adminNotesCount: payload.adminNotes.length,
        updatedAt: payload.updatedAt,
      };
      return res.status(200).json(payload);
    } catch (error: any) {
      return res.status(500).json({ message: error?.message || 'Failed to update ban status.' });
    }
  }
);

router.patch(
  '/users/:id/freeze',
  requireAdmin,
  auditLogger({
    action: 'user.freeze.toggle',
    targetType: 'user',
    resolveTargetId: (req) => getRouteParam(req.params.id),
    captureBefore: async (req) => {
      const targetId = getRouteParam(req.params.id);
      if (!isObjectId(targetId)) return null;
      const user = await User.findById(targetId)
        .select('role isBanned isFrozen adminNotes updatedAt');
      return user
        ? {
            role: resolveUserRole(user.role, !!user.isAdmin),
            isBanned: user.isBanned,
            isFrozen: user.isFrozen,
            adminNotesCount: (user.adminNotes || []).length,
            updatedAt: user.updatedAt,
          }
        : null;
    },
    captureAfter: (_req, res) => res.locals.auditAfterState ?? null,
  }),
  async (req: Request, res: Response) => {
    try {
      const id = getRouteParam(req.params.id);
      if (!isObjectId(id)) {
        return res.status(400).json({ message: 'Invalid user id.' });
      }

      const actor = await getAuthenticatedAdminUser(req);
      if (!actor) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      const user = await User.findById(id)
        .select('username email avatarUrl role isAdmin isBanned isFrozen adminNotes createdAt updatedAt');
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      const requested = req.body?.isFrozen;
      const nextIsFrozen = typeof requested === 'boolean' ? requested : !user.isFrozen;
      user.isFrozen = nextIsFrozen;
      appendAdminNote(user, req.body?.note, actor.username);
      await user.save();

      const payload = serializeUser(user);
      res.locals.auditAfterState = {
        role: payload.role,
        isBanned: payload.isBanned,
        isFrozen: payload.isFrozen,
        adminNotesCount: payload.adminNotes.length,
        updatedAt: payload.updatedAt,
      };
      return res.status(200).json(payload);
    } catch (error: any) {
      return res.status(500).json({ message: error?.message || 'Failed to update freeze status.' });
    }
  }
);

router.patch(
  '/users/:id/role',
  requireSuperAdmin,
  auditLogger({
    action: 'user.role.change',
    targetType: 'user',
    resolveTargetId: (req) => getRouteParam(req.params.id),
    captureBefore: async (req) => {
      const targetId = getRouteParam(req.params.id);
      if (!isObjectId(targetId)) return null;
      const user = await User.findById(targetId)
        .select('role isBanned isFrozen adminNotes updatedAt');
      return user
        ? {
            role: resolveUserRole(user.role, !!user.isAdmin),
            isBanned: user.isBanned,
            isFrozen: user.isFrozen,
            adminNotesCount: (user.adminNotes || []).length,
            updatedAt: user.updatedAt,
          }
        : null;
    },
    captureAfter: (_req, res) => res.locals.auditAfterState ?? null,
  }),
  async (req: Request, res: Response) => {
    try {
      const id = getRouteParam(req.params.id);
      const role = req.body?.role;
      if (!isObjectId(id)) {
        return res.status(400).json({ message: 'Invalid user id.' });
      }
      if (!isUserRole(role)) {
        return res.status(400).json({ message: `role must be one of: ${USER_ROLES.join(', ')}` });
      }

      const actor = await getAuthenticatedAdminUser(req);
      if (!actor) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      const user = await User.findById(id)
        .select('username email avatarUrl role isAdmin isBanned isFrozen adminNotes createdAt updatedAt');
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      user.role = role;
      appendAdminNote(user, req.body?.note, actor.username);
      await user.save();

      const payload = serializeUser(user);
      res.locals.auditAfterState = {
        role: payload.role,
        isBanned: payload.isBanned,
        isFrozen: payload.isFrozen,
        adminNotesCount: payload.adminNotes.length,
        updatedAt: payload.updatedAt,
      };
      return res.status(200).json(payload);
    } catch (error: any) {
      return res.status(500).json({ message: error?.message || 'Failed to change user role.' });
    }
  }
);

router.get('/wallets/search', requireFinance, async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const query = buildUserSearchQuery(q);
    const users = await User.find(query)
      .select('username email avatarUrl role isAdmin isBanned isFrozen adminNotes createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(MAX_USER_SEARCH_RESULTS);

    const results = await Promise.all(
      users.map(async (user) => {
        const wallet = await ensureWalletForUser(user._id);
        return {
          user: serializeUser(user),
          wallet: serializeWallet(wallet),
        };
      })
    );

    return res.status(200).json({
      query: q,
      total: results.length,
      results,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to search wallets.' });
  }
});

router.get('/wallets/:userId', requireFinance, async (req: Request, res: Response) => {
  try {
    const userId = getRouteParam(req.params.userId);
    if (!isObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid user id.' });
    }

    const [user, wallet, transactions] = await Promise.all([
      User.findById(userId).select('username email avatarUrl role isAdmin isBanned isFrozen'),
      ensureWalletForUser(userId),
      Transaction.find({ userId: toObjectId(userId) }).sort({ date: -1 }).limit(100),
    ]);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({
      user: serializeUser(user),
      wallet: serializeWallet(wallet),
      transactions,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to load wallet.' });
  }
});

router.post(
  '/wallets/adjust',
  requireFinance,
  auditLogger({
    action: 'wallet.adjust',
    targetType: 'wallet',
    resolveTargetId: (_req, res) => res.locals.auditTargetId ?? null,
    captureBefore: async (req) => {
      const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
      if (!isObjectId(userId)) return null;
      const wallet = await Wallet.findOne({ userId: toObjectId(userId) });
      return wallet
        ? {
            usdBalance: wallet.usdBalance,
            rtcBalance: wallet.rtcBalance,
            availableBalance: wallet.availableBalance,
            pendingWithdrawals: wallet.pendingWithdrawals,
            lifetimeDeposits: wallet.lifetimeDeposits,
            lifetimeWithdrawals: wallet.lifetimeWithdrawals,
            updatedAt: wallet.updatedAt,
          }
        : null;
    },
    captureAfter: (_req, res) => res.locals.auditAfterState ?? null,
  }),
  async (req: Request, res: Response) => {
    try {
      const actor = await getAuthenticatedAdminUser(req);
      if (!actor) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      const amount = toSafeAmount(req.body?.amount, 'amount');
      const currencyRaw = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : 'USD';
      if (!isAdminWalletAdjustCurrency(currencyRaw)) {
        return res.status(400).json({ message: `currency must be one of: ${ADMIN_WALLET_ADJUST_CURRENCIES.join(', ')}` });
      }
      const currency = currencyRaw;

      if (!isObjectId(userId)) {
        return res.status(400).json({ message: 'userId is required and must be a valid ObjectId.' });
      }
      if (!reason || reason.length < 3) {
        return res.status(400).json({ message: 'reason must be at least 3 characters.' });
      }
      if (amount === 0) {
        return res.status(400).json({ message: 'amount must be non-zero.' });
      }
      if (Math.abs(amount) > MAX_BALANCE_ADJUSTMENT) {
        return res.status(400).json({ message: `amount cannot exceed ${MAX_BALANCE_ADJUSTMENT} in magnitude.` });
      }
      if (amount < 0 && !roleAtLeast(actor.role, 'finance')) {
        return res.status(403).json({ message: 'Only finance role or above can perform negative adjustments.' });
      }

      const user = await User.findById(userId).select('username email');
      if (!user) {
        return res.status(404).json({ message: 'Target user not found.' });
      }

      const wallet = await ensureWalletForUser(userId);
      if (currency === 'USD') {
        const nextUsdBalance = Math.round((wallet.usdBalance + amount) * 100) / 100;
        if (nextUsdBalance < 0) {
          return res.status(400).json({ message: 'Adjustment would result in a negative USD balance.' });
        }

        wallet.usdBalance = nextUsdBalance;
        wallet.availableBalance = nextUsdBalance;
        if (amount > 0) {
          wallet.lifetimeDeposits = Math.round((wallet.lifetimeDeposits + amount) * 100) / 100;
        } else {
          wallet.lifetimeWithdrawals = Math.round((wallet.lifetimeWithdrawals + Math.abs(amount)) * 100) / 100;
        }
      } else {
        const nextRtcBalance = Math.round((wallet.rtcBalance + amount) * 100) / 100;
        if (nextRtcBalance < 0) {
          return res.status(400).json({ message: 'Adjustment would result in a negative RTC balance.' });
        }
        wallet.rtcBalance = nextRtcBalance;
      }
      await wallet.save();

      const transaction = new Transaction({
        userId: user._id,
        type: amount >= 0 ? 'Deposit' : 'Withdrawal',
        amount,
        currency,
        status: 'Completed',
        details: {
          paymentId: 'ADMIN_ADJUSTMENT',
          adminUserId: actor.id,
          reason,
          currency,
        },
      });
      await transaction.save();

      await logLedgerEntry({
        userId: user._id,
        currency,
        eventType:
          currency === 'USD'
            ? amount >= 0
              ? 'USD_DEPOSIT'
              : 'USD_WITHDRAWAL'
            : amount >= 0
              ? 'SYSTEM_MINT'
              : 'SYSTEM_BURN',
        direction: amount >= 0 ? 'credit' : 'debit',
        amount: Math.abs(amount),
        status: 'completed',
        balanceAfter: currency === 'USD' ? wallet.usdBalance : wallet.rtcBalance,
        referenceType: 'admin_adjustment',
        referenceId: transaction._id.toString(),
        metadata: {
          reason,
          adminUserId: actor.id,
          currency,
          direction: amount >= 0 ? 'credit' : 'debit',
        },
      });

      res.locals.auditTargetId = wallet._id.toString();
      res.locals.auditAfterState = {
        usdBalance: wallet.usdBalance,
        rtcBalance: wallet.rtcBalance,
        availableBalance: wallet.availableBalance,
        pendingWithdrawals: wallet.pendingWithdrawals,
        lifetimeDeposits: wallet.lifetimeDeposits,
        lifetimeWithdrawals: wallet.lifetimeWithdrawals,
        adjustmentCurrency: currency,
        adjustmentAmount: amount,
        transactionId: transaction._id.toString(),
      };

      return res.status(200).json({
        message: 'Wallet adjustment applied.',
        wallet: serializeWallet(wallet),
        transaction,
      });
    } catch (error: any) {
      return res.status(400).json({ message: error?.message || 'Failed to adjust wallet.' });
    }
  }
);

router.get('/withdrawals', requireFinance, async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : 'pending';
    const query = status === 'all'
      ? {}
      : { status };

    const requests = await WithdrawalRequest.find(query)
      .populate('userId', 'username email')
      .sort({ requestedAt: -1 });

    return res.status(200).json({
      total: requests.length,
      withdrawals: requests.map(serializeWithdrawal),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch withdrawals.' });
  }
});

router.patch(
  '/withdrawals/:id/approve',
  requireFinance,
  auditLogger({
    action: 'withdrawal.approve',
    targetType: 'wallet',
    resolveTargetId: (req) => getRouteParam(req.params.id),
    captureBefore: async (req) => {
      const requestId = getRouteParam(req.params.id);
      const request = await WithdrawalRequest.findById(requestId);
      return request
        ? {
            status: request.status,
            amount: request.amount,
            processedAt: request.processedAt,
          }
        : null;
    },
    captureAfter: (_req, res) => res.locals.auditAfterState ?? null,
  }),
  async (req: Request, res: Response) => {
    try {
      const actor = await getAuthenticatedAdminUser(req);
      if (!actor) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      const requestId = getRouteParam(req.params.id);
      const request = await WithdrawalRequest.findById(requestId);
      if (!request) {
        return res.status(404).json({ message: 'Withdrawal request not found.' });
      }
      if (request.status !== 'pending') {
        return res.status(400).json({ message: 'Only pending withdrawals can be approved.' });
      }

      const wallet = await ensureWalletForUser(request.userId as mongoose.Types.ObjectId);
      wallet.pendingWithdrawals = Math.max(0, Math.round((wallet.pendingWithdrawals - request.amount) * 100) / 100);
      wallet.lifetimeWithdrawals = Math.round((wallet.lifetimeWithdrawals + request.amount) * 100) / 100;
      await wallet.save();

      request.status = 'approved';
      request.processedAt = new Date();
      request.processedBy = toObjectId(actor.id);
      request.transactionId = typeof req.body?.transactionId === 'string' && req.body.transactionId.trim()
        ? req.body.transactionId.trim()
        : request.transactionId || 'MANUAL_APPROVAL';
      await request.save();

      await Transaction.findOneAndUpdate(
        { 'details.withdrawalRequestId': request._id },
        { status: 'Completed' }
      );

      await logLedgerEntry({
        userId: request.userId,
        currency: 'USD',
        eventType: 'USD_WITHDRAWAL',
        direction: 'debit',
        amount: request.amount,
        status: 'completed',
        balanceAfter: wallet.usdBalance,
        referenceType: 'withdrawal_request',
        referenceId: request._id.toString(),
        metadata: {
          adminUserId: actor.id,
          action: 'approve',
          transactionId: request.transactionId,
        },
      });

      res.locals.auditAfterState = {
        status: request.status,
        amount: request.amount,
        processedAt: request.processedAt,
        processedBy: request.processedBy?.toString(),
        transactionId: request.transactionId,
      };

      return res.status(200).json({
        message: 'Withdrawal approved.',
        withdrawal: serializeWithdrawal(request),
      });
    } catch (error: any) {
      return res.status(500).json({ message: error?.message || 'Failed to approve withdrawal.' });
    }
  }
);

router.patch(
  '/withdrawals/:id/reject',
  requireFinance,
  auditLogger({
    action: 'withdrawal.reject',
    targetType: 'wallet',
    resolveTargetId: (req) => getRouteParam(req.params.id),
    captureBefore: async (req) => {
      const requestId = getRouteParam(req.params.id);
      const request = await WithdrawalRequest.findById(requestId);
      return request
        ? {
            status: request.status,
            amount: request.amount,
            processedAt: request.processedAt,
          }
        : null;
    },
    captureAfter: (_req, res) => res.locals.auditAfterState ?? null,
  }),
  async (req: Request, res: Response) => {
    try {
      const actor = await getAuthenticatedAdminUser(req);
      if (!actor) {
        return res.status(401).json({ message: 'Unauthorized.' });
      }

      const requestId = getRouteParam(req.params.id);
      const request = await WithdrawalRequest.findById(requestId);
      if (!request) {
        return res.status(404).json({ message: 'Withdrawal request not found.' });
      }
      if (request.status !== 'pending') {
        return res.status(400).json({ message: 'Only pending withdrawals can be rejected.' });
      }

      const wallet = await ensureWalletForUser(request.userId as mongoose.Types.ObjectId);
      wallet.pendingWithdrawals = Math.max(0, Math.round((wallet.pendingWithdrawals - request.amount) * 100) / 100);
      wallet.usdBalance = Math.round((wallet.usdBalance + request.amount) * 100) / 100;
      wallet.availableBalance = wallet.usdBalance;
      await wallet.save();

      request.status = 'rejected';
      request.processedAt = new Date();
      request.processedBy = toObjectId(actor.id);
      await request.save();

      await Transaction.findOneAndUpdate(
        { 'details.withdrawalRequestId': request._id },
        { status: 'Failed' }
      );

      await logLedgerEntry({
        userId: request.userId,
        currency: 'USD',
        eventType: 'USD_WITHDRAWAL',
        direction: 'credit',
        amount: request.amount,
        status: 'failed',
        balanceAfter: wallet.usdBalance,
        referenceType: 'withdrawal_request',
        referenceId: request._id.toString(),
        metadata: {
          adminUserId: actor.id,
          action: 'reject',
        },
      });

      res.locals.auditAfterState = {
        status: request.status,
        amount: request.amount,
        processedAt: request.processedAt,
        processedBy: request.processedBy?.toString(),
      };

      return res.status(200).json({
        message: 'Withdrawal rejected.',
        withdrawal: serializeWithdrawal(request),
      });
    } catch (error: any) {
      return res.status(500).json({ message: error?.message || 'Failed to reject withdrawal.' });
    }
  }
);

router.get('/tables', requireAdmin, async (req: Request, res: Response) => {
  try {
    const requestedStatus = typeof req.query.status === 'string'
      ? req.query.status.trim().toLowerCase()
      : 'all';
    if (!isTableStatusFilter(requestedStatus)) {
      return res.status(400).json({
        message: `status must be one of: ${TABLE_STATUS_FILTERS.join(', ')}`,
      });
    }

    const tableQuery = requestedStatus === 'all' ? {} : { status: requestedStatus };
    const tables = await Table.find(tableQuery).sort({ updatedAt: -1, createdAt: -1 });
    const serialized = await Promise.all(tables.map((table) => serializeAdminTable(table)));
    const liveCount = serialized.filter((table) => table.status === 'in-game').length;

    return res.status(200).json({
      status: requestedStatus,
      total: serialized.length,
      liveCount,
      waitingCount: serialized.length - liveCount,
      tables: serialized,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch tables.' });
  }
});

router.get('/tables/live', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const tables = await Table.find({ status: 'in-game' }).sort({ updatedAt: -1, createdAt: -1 });
    const serialized = await Promise.all(tables.map((table) => serializeAdminTable(table)));

    return res.status(200).json({
      total: serialized.length,
      tables: serialized,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch live tables.' });
  }
});

router.get('/tables/promo', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const table = await Table.findOne({ isPromo: true }).sort({ updatedAt: -1, createdAt: -1 });
    if (!table) {
      return res.status(200).json({ table: null });
    }

    return res.status(200).json({
      table: await serializeAdminTable(table),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to load promo table.' });
  }
});

router.post(
  '/tables/promo/ensure',
  requireAdmin,
  auditLogger({
    action: 'table.promo.ensure',
    targetType: 'table',
    resolveTargetId: (_req, res) => res.locals.auditTargetId ?? null,
    captureBefore: async () => {
      const table = await Table.findOne({ isPromo: true }).sort({ updatedAt: -1, createdAt: -1 });
      return table
        ? {
            tableId: table._id.toString(),
            status: table.status,
            currentPlayerCount: table.currentPlayerCount,
            isPromo: !!table.isPromo,
          }
        : null;
    },
    captureAfter: (_req, res) => res.locals.auditAfterState ?? null,
  }),
  async (req: Request, res: Response) => {
    try {
      let table = await Table.findOne({ isPromo: true }).sort({ updatedAt: -1, createdAt: -1 });
      const shouldReset = req.body?.reset === true;

      if (!table) {
        table = new Table({
          name: PROMO_TABLE_NAME,
          stake: 1,
          mode: GameMode.FREE_RTC_TABLE,
          isPrivate: true,
          isPromo: true,
          minPlayers: 4,
          maxPlayers: 4,
          currentPlayerCount: 0,
          players: [],
          status: 'waiting',
        });
      } else if (shouldReset) {
        await resetTableRuntimeState(table, false);
      }

      if (!table) {
        throw new Error('Promo table could not be initialized.');
      }
      const promoTable = table;

      const currentGameState = promoTable.isNew ? null : await loadGameState(promoTable._id.toString());
      const aiCount = Array.isArray(promoTable.players) ? promoTable.players.filter((player: any) => player?.isAI).length : 0;
      const needsSeed =
        shouldReset ||
        !currentGameState ||
        aiCount !== PROMO_AI_NAMES.length ||
        promoTable.maxPlayers !== 4 ||
        !promoTable.isPromo;

      if (needsSeed) {
        table = await seedPromoTableState(promoTable);
      } else {
        promoTable.name = PROMO_TABLE_NAME;
        promoTable.isPrivate = true;
        promoTable.isPromo = true;
        await promoTable.save();
        table = promoTable;
      }

      const resolvedTable = table!;
      const serialized = await serializeAdminTable(resolvedTable);
      res.locals.auditTargetId = resolvedTable._id.toString();
      res.locals.auditAfterState = {
        tableId: serialized.tableId,
        status: serialized.status,
        currentPlayerCount: serialized.currentPlayerCount,
        isPromo: serialized.isPromo,
      };

      return res.status(200).json({
        table: serialized,
      });
    } catch (error: any) {
      return res.status(500).json({ message: error?.message || 'Failed to provision promo table.' });
    }
  }
);

router.post(
  '/tables/:tableId/reset',
  requireAdmin,
  auditLogger({
    action: 'table.reset',
    targetType: 'table',
    resolveTargetId: (req) => getRouteParam(req.params.tableId),
    captureBefore: async (req) => {
      const tableId = getRouteParam(req.params.tableId);
      if (!isObjectId(tableId)) return null;
      const table = await Table.findById(tableId);
      return table
        ? {
            status: table.status,
            currentPlayerCount: table.currentPlayerCount,
            activeContestId: table.activeContestId ?? null,
            currentMatchId: table.currentMatchId?.toString?.() ?? null,
          }
        : null;
    },
    captureAfter: (_req, res) => res.locals.auditAfterState ?? null,
  }),
  async (req: Request, res: Response) => {
    try {
      const tableId = getRouteParam(req.params.tableId);
      if (!isObjectId(tableId)) {
        return res.status(400).json({ message: 'Invalid table id.' });
      }

      const table = await Table.findById(tableId);
      if (!table) {
        return res.status(404).json({ message: 'Table not found.' });
      }

      const keepContestBinding = req.body?.keepContestBinding === true;
      await resetTableRuntimeState(table, keepContestBinding);

      res.locals.auditAfterState = {
        status: table.status,
        currentPlayerCount: table.currentPlayerCount,
        activeContestId: table.activeContestId ?? null,
        currentMatchId: table.currentMatchId?.toString?.() ?? null,
      };
      return res.status(200).json(table);
    } catch (error: any) {
      return res.status(500).json({ message: error?.message || 'Failed to reset table.' });
    }
  }
);

router.get('/matches/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = getRouteParam(req.params.id);
    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid match id.' });
    }

    const match = await Match.findById(id);
    if (!match) {
      return res.status(404).json({ message: 'Match not found.' });
    }

    return res.status(200).json(match);
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch match.' });
  }
});

router.get('/system/metrics', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [
      totalUsers,
      bannedUsers,
      frozenUsers,
      privilegedUsers,
      activeTables,
      activeMatches,
      pendingWithdrawals,
      totalWallets,
      usdWalletTotals,
      rtcWalletTotals,
      openContests,
      matchesLast24h,
      auditsLast24h,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ isBanned: true }),
      User.countDocuments({ isFrozen: true }),
      User.countDocuments({ role: { $in: ['moderator', 'finance', 'admin', 'superadmin'] } }),
      Table.countDocuments({ status: 'in-game' }),
      Match.countDocuments({ status: 'in-progress' }),
      WithdrawalRequest.countDocuments({ status: 'pending' }),
      Wallet.countDocuments({}),
      Wallet.aggregate([{ $group: { _id: null, total: { $sum: '$usdBalance' } } }]),
      Wallet.aggregate([{ $group: { _id: null, total: { $sum: '$rtcBalance' } } }]),
      Contest.countDocuments({ status: { $in: ['open', 'locked', 'in-progress'] } }),
      Match.countDocuments({ createdAt: { $gte: dayAgo } }),
      AdminAudit.countDocuments({ createdAt: { $gte: dayAgo } }),
    ]);

    const memory = process.memoryUsage();

    return res.status(200).json({
      generatedAt: now.toISOString(),
      users: {
        total: totalUsers,
        privileged: privilegedUsers,
        banned: bannedUsers,
        frozen: frozenUsers,
      },
      operations: {
        activeTables,
        activeMatches,
        openContests,
        pendingWithdrawals,
        matchesLast24h,
        auditsLast24h,
      },
      wallets: {
        totalWallets,
        totalUsdBalance: usdWalletTotals[0]?.total ?? 0,
        totalRtcBalance: rtcWalletTotals[0]?.total ?? 0,
      },
      runtime: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external,
        },
        redisConnected: redisClient.isReady,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch system metrics.' });
  }
});

router.get('/audits', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = toPagination(req);
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const adminUserId = typeof req.query.adminUserId === 'string' ? req.query.adminUserId.trim() : '';
    const targetType = typeof req.query.targetType === 'string' ? req.query.targetType.trim() : '';

    const query: Record<string, unknown> = {};
    if (action) {
      query.action = action;
    }
    if (targetType) {
      query.targetType = targetType;
    }
    if (adminUserId && isObjectId(adminUserId)) {
      query.adminUserId = toObjectId(adminUserId);
    }

    const [records, total] = await Promise.all([
      AdminAudit.find(query)
        .populate('adminUserId', 'username email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      AdminAudit.countDocuments(query),
    ]);

    return res.status(200).json({
      page,
      limit,
      total,
      records,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch audit logs.' });
  }
});

router.get('/tournaments', requireAdmin, async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
    const query = status ? { status } : {};
    const tournaments = await Contest.find(query).sort({ createdAt: -1 }).limit(100);
    return res.status(200).json({
      total: tournaments.length,
      tournaments,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch tournaments.' });
  }
});

router.get('/overview', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [users, admins, finance, moderators, tables, pendingWithdrawals] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: { $in: ['admin', 'superadmin'] } }),
      User.countDocuments({ role: { $in: ['finance', 'admin', 'superadmin'] } }),
      User.countDocuments({ role: 'moderator' }),
      Table.countDocuments({}),
      WithdrawalRequest.countDocuments({ status: 'pending' }),
    ]);

    return res.status(200).json({
      users,
      admins,
      finance,
      moderators,
      tables,
      pendingWithdrawals,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to load overview.' });
  }
});

export default router;
