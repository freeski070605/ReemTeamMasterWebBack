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

const router = Router();

const MAX_USER_SEARCH_RESULTS = 50;
const MAX_ADMIN_NOTE_LENGTH = 500;
const MAX_BALANCE_ADJUSTMENT = 100_000;

const isObjectId = (value: string): boolean => mongoose.Types.ObjectId.isValid(value);

const toObjectId = (value: string): mongoose.Types.ObjectId => new mongoose.Types.ObjectId(value);

const getRouteParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
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

router.use(authMiddleware);
router.use(adminRateLimiter);

router.get('/users/search', requireAdmin, async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const query = q.length > 0
      ? {
          $or: [
            { username: { $regex: q, $options: 'i' } },
            { email: { $regex: q, $options: 'i' } },
          ],
        }
      : {};

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
      await wallet.save();

      const transaction = new Transaction({
        userId: user._id,
        type: amount >= 0 ? 'Deposit' : 'Withdrawal',
        amount,
        currency: 'USD',
        status: 'Completed',
        details: {
          paymentId: 'ADMIN_ADJUSTMENT',
          adminUserId: actor.id,
          reason,
        },
      });
      await transaction.save();

      await logLedgerEntry({
        userId: user._id,
        currency: 'USD',
        eventType: amount >= 0 ? 'USD_DEPOSIT' : 'USD_WITHDRAWAL',
        direction: amount >= 0 ? 'credit' : 'debit',
        amount: Math.abs(amount),
        status: 'completed',
        balanceAfter: wallet.usdBalance,
        referenceType: 'admin_adjustment',
        referenceId: transaction._id.toString(),
        metadata: {
          reason,
          adminUserId: actor.id,
          direction: amount >= 0 ? 'credit' : 'debit',
        },
      });

      res.locals.auditTargetId = wallet._id.toString();
      res.locals.auditAfterState = {
        usdBalance: wallet.usdBalance,
        availableBalance: wallet.availableBalance,
        pendingWithdrawals: wallet.pendingWithdrawals,
        lifetimeDeposits: wallet.lifetimeDeposits,
        lifetimeWithdrawals: wallet.lifetimeWithdrawals,
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

router.get('/tables/live', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const tables = await Table.find({ status: 'in-game' }).sort({ updatedAt: -1, createdAt: -1 });

    const live = await Promise.all(tables.map(async (table) => {
      const gameState = await loadGameState(table._id.toString());
      const currentPlayer = gameState?.players?.[gameState.currentPlayerIndex];
      const turnTimeRemainingMs = gameState
        ? Math.max(0, (gameState.turnExpiresAt ?? Date.now()) - Date.now())
        : null;

      return {
        tableId: table._id.toString(),
        name: table.name,
        mode: table.mode,
        stake: table.stake,
        status: table.status,
        activeContestId: table.activeContestId ?? null,
        playersSeated: gameState
          ? gameState.players.map((player) => ({
              userId: player.userId,
              username: player.username,
              isAI: player.isAI,
            }))
          : table.players.map((player) => ({
              userId: player.userId.toString(),
              username: player.isAI ? `AI_${player.userId.toString().slice(-4)}` : 'Player',
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
      };
    }));

    return res.status(200).json({
      total: live.length,
      tables: live,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to fetch live tables.' });
  }
});

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
