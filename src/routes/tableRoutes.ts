import express from 'express';
import { randomBytes } from 'crypto';

import Table from '../models/Table';
import Invite from '../models/Invite';
import authMiddleware from '../middleware/auth';
import User from '../models/User';

import {
  resolveUserRole,
  roleAtLeast
} from '../constants/roles';

import {
  isVipActive
} from '../utils/vip';

import {
  GameMode
} from '../domain/gameMode';

import {
  resolveFrontendBaseUrl
} from '../config/frontend';

import {
  pickQuickPlayTable
} from '../services/quickPlayService';

import {
  ensureWalletForUser
} from '../services/walletProvisioningService';

import {
  resolveStakeAmountForMode
} from '../config/economy';

const PUBLIC_RTC_STAKE_OPTIONS =
  [1, 5, 10, 20, 50];

const PRIVATE_RTC_STAKE_OPTIONS =
  [1, 5, 10, 25, 50];

const PRIVATE_USD_STAKE_OPTIONS =
  [5, 10, 20, 50, 100];

const router =
  express.Router();

const parseBoolean = (
  value: unknown,
  fallback: boolean
) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized =
      value.trim().toLowerCase();

    if (
      ['1', 'true', 'yes', 'on']
        .includes(normalized)
    ) {
      return true;
    }

    if (
      ['0', 'false', 'no', 'off']
        .includes(normalized)
    ) {
      return false;
    }
  }

  return fallback;
};

const isInviteUsable = (
  invite: any
) => {
  if (!invite) {
    return false;
  }

  const expired =
    invite.expiresAt &&
    invite.expiresAt.getTime() <=
      Date.now();

  const maxed =
    invite.maxUses > 0 &&
    invite.uses >= invite.maxUses;

  return !expired && !maxed;
};

const serializeOwnedPrivateTable =
  async (
    table: any,
    req: express.Request
  ) => {
    const invites =
      await Invite.find({
        tableId: table._id,
        purpose: 'table'
      })
        .sort({
          createdAt: -1
        })
        .limit(10)
        .select(
          'code expiresAt maxUses uses'
        );

    const activeInvite =
      invites.find(
        (invite) =>
          isInviteUsable(invite)
      );

    return {
      _id:
        table._id.toString(),

      name:
        table.name,

      stake:
        table.stake,

      mode:
        table.mode,

      isPrivate:
        !!table.isPrivate,

      isPromo:
        !!table.isPromo,

      createdBy:
        table.createdBy
          ?.toString?.() ??
        null,

      hostNote:
        table.hostNote ??
        null,

      minPlayers:
        table.minPlayers,

      maxPlayers:
        table.maxPlayers,

      currentPlayerCount:
        table.currentPlayerCount,

      players:
        Array.isArray(table.players)
          ? table.players.map(
              (player: any) => ({
                userId:
                  player.userId
                    ?.toString?.() ??
                  player.userId,

                isAI:
                  !!player.isAI,

                seat:
                  player.seat
              })
            )
          : [],

      status:
        table.status,

      createdAt:
        table.createdAt,

      updatedAt:
        table.updatedAt,

      inviteCode:
        activeInvite?.code ??
        null,

      inviteUrl:
        activeInvite
          ? `${resolveFrontendBaseUrl(req)}/invite/${activeInvite.code}`
          : null,

      inviteExpiresAt:
        activeInvite?.expiresAt ??
        null
    };
  };

// ================================================================
// PUBLIC TABLE LIST
// ================================================================

// GET /api/tables
router.get(
  '/',
  async (req, res) => {
    try {
      const includePrivate =
        req.query.includePrivate ===
        'true';

      const query =
        includePrivate
          ? {
              isPromo: {
                $ne: true
              }
            }
          : {
              isPrivate: {
                $ne: true
              },

              isPromo: {
                $ne: true
              }
            };

      const tables =
        await Table.find(query)
          .sort({
            stake: 1
          });

      return res.json(
        tables
      );
    } catch (error) {
      console.error(
        'Error fetching tables:',
        error
      );

      return res
        .status(500)
        .json({
          message:
            'Server error fetching tables'
        });
    }
  }
);

// ================================================================
// QUICK PLAY
//
// DO NOT FILTER THIS BY A CHOSEN DENOMINATION.
//
// This remains the "put me somewhere good" path.
// ================================================================

// POST /api/tables/quick-seat
router.post(
  '/quick-seat',
  async (req, res) => {
    try {
      const requestedMode =
        typeof req.body?.mode ===
        'string'
          ? req.body.mode
          : undefined;

      const beginnerMode =
        parseBoolean(
          req.body?.beginnerMode,
          true
        );

      const modeFilter =
        requestedMode &&
        requestedMode !==
          'USD_CONTEST'
          ? {
              mode:
                requestedMode
            }
          : {
              mode: {
                $ne:
                  'USD_CONTEST'
              }
            };

      const tables =
        await Table.find({
          ...modeFilter,

          isPrivate: {
            $ne: true
          },

          isPromo: {
            $ne: true
          },

          $expr: {
            $lt: [
              '$currentPlayerCount',
              '$maxPlayers'
            ]
          }
        }).select(
          'name stake mode isPrivate isPromo minPlayers maxPlayers currentPlayerCount status players'
        );

      const selection =
        pickQuickPlayTable(
          tables,
          {
            beginnerMode
          }
        );

      if (
        !selection.table ||
        !selection.reason
      ) {
        return res
          .status(404)
          .json({
            message:
              'No open tables available right now.'
          });
      }

      const selected =
        selection.table;

      return res
        .status(200)
        .json({
          tableId:
            selected._id,

          table:
            selected,

          reason:
            selection.reason,

          beginnerFriendly:
            selection
              .beginnerFriendly,

          availableOpenTables:
            tables.length
        });
    } catch (error) {
      console.error(
        'Error finding quick seat:',
        error
      );

      return res
        .status(500)
        .json({
          message:
            'Server error finding quick seat.'
        });
    }
  }
);

// ================================================================
// SEAT BY DENOMINATION
//
// Clicking $1/$5/$10/$20/$50 means THAT denomination.
//
// We may choose between multiple server table instances inside
// that denomination, but we NEVER cross to another denomination.
// ================================================================

// POST /api/tables/seat-by-stake
router.post(
  '/seat-by-stake',
  authMiddleware,
  async (req, res) => {
    try {
      const userId =
        (req.user as any)?.id;

      if (!userId) {
        return res
          .status(401)
          .json({
            message:
              'Sign in to choose a table.'
          });
      }

      const stake =
        Number(
          req.body?.stake
        );

      if (
        !Number.isFinite(stake) ||
        !PUBLIC_RTC_STAKE_OPTIONS
          .includes(stake)
      ) {
        return res
          .status(400)
          .json({
            message:
              'Choose an RTC table: 1, 5, 10, 20, or 50.'
          });
      }

      // ----------------------------------------------------------
      // SAME RTC BUFFER REQUIREMENT THE LIVE CRIB USES
      // ----------------------------------------------------------

      const wallet =
        await ensureWalletForUser(
          userId
        );

      const stakeAmount =
        resolveStakeAmountForMode(
          stake,
          GameMode.FREE_RTC_TABLE
        );

      const requiredRtc =
        stakeAmount * 4;

      const availableRtc =
        Number(
          wallet.rtcBalance ?? 0
        );

      if (
        availableRtc <
        requiredRtc
      ) {
        return res
          .status(403)
          .json({
            message:
              `You need ${requiredRtc.toLocaleString()} RTC to sit at the ${stake} table.`,

            stake,
            availableRtc,
            requiredRtc
          });
      }

      // ----------------------------------------------------------
      // ONLY THIS DENOMINATION
      // ----------------------------------------------------------

      const tables =
        await Table.find({
          mode:
            GameMode.FREE_RTC_TABLE,

          stake,

          isPrivate: {
            $ne: true
          },

          isPromo: {
            $ne: true
          },

          $expr: {
            $lt: [
              '$currentPlayerCount',
              '$maxPlayers'
            ]
          }
        }).select(
          'name stake mode isPrivate isPromo minPlayers maxPlayers currentPlayerCount status players'
        );

      if (tables.length === 0) {
        return res
          .status(404)
          .json({
            message:
              `No open ${stake} table right now.`,

            stake
          });
      }

      // If there are two $10 tables, for example,
      // choose the better $10 table.
      //
      // This does NOT permit another denomination.

      const selection =
        pickQuickPlayTable(
          tables,
          {
            beginnerMode:
              false
          }
        );

      if (
        !selection.table
      ) {
        return res
          .status(404)
          .json({
            message:
              `No open ${stake} table right now.`,

            stake
          });
      }

      const selected =
        selection.table;

      return res
        .status(200)
        .json({
          tableId:
            selected._id,

          table:
            selected,

          reason:
            selection.reason,

          beginnerFriendly:
            selection
              .beginnerFriendly,

          requestedStake:
            stake,

          availableOpenTables:
            tables.length
        });
    } catch (error) {
      console.error(
        'Error seating player by stake:',
        error
      );

      return res
        .status(500)
        .json({
          message:
            'Server error choosing table.'
        });
    }
  }
);

// ================================================================
// PRIVATE TABLES
// ================================================================

// GET /api/tables/private/mine
router.get(
  '/private/mine',
  authMiddleware,
  async (req, res) => {
    try {
      const userId =
        (req.user as any)?.id;

      if (!userId) {
        return res
          .status(401)
          .json({
            message:
              'Unauthorized: User ID not found.'
          });
      }

      const tables =
        await Table.find({
          createdBy:
            userId,

          isPrivate:
            true,

          isPromo: {
            $ne: true
          }
        }).sort({
          updatedAt: -1,
          createdAt: -1
        });

      const serialized =
        await Promise.all(
          tables.map(
            (table) =>
              serializeOwnedPrivateTable(
                table,
                req
              )
          )
        );

      return res
        .status(200)
        .json({
          total:
            serialized.length,

          tables:
            serialized
        });
    } catch (error) {
      console.error(
        'Error loading owned private tables:',
        error
      );

      return res
        .status(500)
        .json({
          message:
            'Server error loading private tables.'
        });
    }
  }
);

// POST /api/tables/private
router.post(
  '/private',
  authMiddleware,
  async (req, res) => {
    try {
      const userId =
        (req.user as any)?.id;

      if (!userId) {
        return res
          .status(401)
          .json({
            message:
              'Unauthorized: User ID not found.'
          });
      }

      const user =
        await User.findById(
          userId
        ).select(
          'vipStatus vipExpiresAt role isAdmin'
        );

      if (!user) {
        return res
          .status(404)
          .json({
            message:
              'User not found.'
          });
      }

      const resolvedRole =
        resolveUserRole(
          user.role,
          !!user.isAdmin
        );

      const hasAdminBypass =
        roleAtLeast(
          resolvedRole,
          'admin'
        );

      const isVip =
        isVipActive(
          user.vipStatus,
          user.vipExpiresAt
        );

      if (
        !isVip &&
        !hasAdminBypass
      ) {
        return res
          .status(403)
          .json({
            message:
              'VIP subscription required to create private tables.'
          });
      }

      const requestedMode =
        req.body?.mode;

      const mode =
        requestedMode ===
        GameMode.PRIVATE_USD_TABLE
          ? GameMode.PRIVATE_USD_TABLE
          : GameMode.FREE_RTC_TABLE;

      const stake =
        Number(
          req.body?.stake
        );

      const maxPlayers =
        Number(
          req.body?.maxPlayers
        );

      const hostNote =
        typeof req.body?.hostNote ===
        'string'
          ? req.body
              .hostNote
              .trim()
              .slice(
                0,
                160
              )
          : '';

      if (
        !Number.isFinite(stake) ||
        stake <= 0
      ) {
        return res
          .status(400)
          .json({
            message:
              'Invalid stake.'
          });
      }

      const allowedStakes =
        mode ===
        GameMode.PRIVATE_USD_TABLE
          ? PRIVATE_USD_STAKE_OPTIONS
          : PRIVATE_RTC_STAKE_OPTIONS;

      if (
        !allowedStakes.includes(
          stake
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              mode ===
              GameMode.PRIVATE_USD_TABLE
                ? 'Choose one of the supported USD stakes: $5, $10, $20, $50, or $100.'
                : 'Choose one of the supported RTC stakes: 1, 5, 10, 25, or 50.'
          });
      }

      const resolvedMaxPlayers =
        Number.isFinite(
          maxPlayers
        )
          ? Math.min(
              Math.max(
                maxPlayers,
                2
              ),
              4
            )
          : 4;

      const suffix =
        randomBytes(2)
          .toString('hex')
          .toUpperCase();

      const tableName =
        mode ===
        GameMode.PRIVATE_USD_TABLE
          ? `Private Cash Table ${suffix}`
          : `Private RTC Table ${suffix}`;

      const table =
        new Table({
          name:
            tableName,

          stake,

          mode,

          minPlayers:
            2,

          maxPlayers:
            resolvedMaxPlayers,

          currentPlayerCount:
            0,

          players:
            [],

          status:
            'waiting',

          isPrivate:
            true,

          isPromo:
            false,

          createdBy:
            userId,

          hostNote:
            hostNote ||
            undefined
        });

      await table.save();

      const code =
        randomBytes(4)
          .toString('hex');

      const invite =
        await Invite.create({
          code,

          purpose:
            'table',

          tableId:
            table._id,

          createdBy:
            userId,

          maxUses:
            0,

          expiresAt:
            new Date(
              Date.now() +
              7 *
              24 *
              60 *
              60 *
              1000
            )
        });

      const inviteUrl =
        `${resolveFrontendBaseUrl(req)}/invite/${invite.code}`;

      return res
        .status(201)
        .json({
          table,
          inviteCode:
            invite.code,
          inviteUrl
        });
    } catch (error) {
      console.error(
        'Error creating private table:',
        error
      );

      return res
        .status(500)
        .json({
          message:
            'Server error creating private table.'
        });
    }
  }
);

export default router;