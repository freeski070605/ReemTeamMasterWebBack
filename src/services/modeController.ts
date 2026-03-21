import { Types } from 'mongoose';
import { redisClient } from '../config/redis';
import { DEFAULT_GAME_MODE, GameMode } from '../domain/gameMode';
import {
  finalizeRoundState,
  IGameState,
  IPlacement,
  RoundEndType,
} from '../game/gameEngine';
import Match from '../models/Match';
import Table from '../models/Table';
import TournamentTicket from '../models/TournamentTicket';
import { logLedgerEntry } from './ledgerService';
import { RtcEconomyService } from './rtcEconomyService';
import { ContestService } from './contestService';
import User from '../models/User';
import { resolveUserRole, roleAtLeast } from '../constants/roles';

interface RoundSettlementData {
  winnerPayout: number;
  penalties: Array<{ playerId: string; amount: number }>;
  payouts: { [userId: string]: number };
}

const getRoundReference = (gameState: IGameState): string => {
  const ts = gameState.lastAction?.timestamp ?? 0;
  return `${gameState.tableId}:${gameState.turn}:${gameState.currentDealerIndex}:${ts}`;
};

const getSettlementReference = (gameState: IGameState): string => {
  const winType = gameState.roundEndedBy ?? 'UNKNOWN';
  const winner = gameState.roundWinnerId ?? 'NONE';
  return `${getRoundReference(gameState)}:${winner}:${winType}`;
};

const toObjectId = (id: string): Types.ObjectId => new Types.ObjectId(id);

const resolveMode = async (gameState: IGameState): Promise<GameMode> => {
  if (gameState.mode) {
    return gameState.mode;
  }

  const table = await Table.findById(gameState.tableId).select('mode');
  if (!table?.mode) {
    return DEFAULT_GAME_MODE;
  }

  return table.mode as GameMode;
};

const resolveContestId = async (gameState: IGameState): Promise<string | null> => {
  if (gameState.contestId) {
    return gameState.contestId;
  }

  const table = await Table.findById(gameState.tableId).select('activeContestId');
  return table?.activeContestId ?? null;
};

const calculateRoundSettlement = (gameState: IGameState): RoundSettlementData => {
  const { pot, baseStake, roundEndedBy, roundWinnerId, caughtDroppingPlayerId, players } = gameState;

  if (!roundWinnerId || !roundEndedBy) {
    return { winnerPayout: 0, penalties: [], payouts: {} };
  }

  const penalties: Array<{ playerId: string; amount: number }> = [];
  const losers = players.filter((player) => player.userId !== roundWinnerId);

  let winnerPayout = 0;
  switch (roundEndedBy) {
    case 'REGULAR':
    case 'DECK_EMPTY':
      winnerPayout = pot;
      break;
    case 'REEM': {
      // All players already ante'd one stake into the pot. Reem means +1 additional stake from each loser.
      const penaltyAmount = baseStake;
      winnerPayout = pot + (penaltyAmount * losers.length);
      losers.forEach((loser) => {
        penalties.push({ playerId: loser.userId, amount: penaltyAmount });
      });
      break;
    }
    case 'AUTO_TRIPLE': {
      // All players already ante'd one stake into the pot. Triple means +2 additional stakes from each loser.
      const penaltyAmount = baseStake * 2;
      winnerPayout = pot + (penaltyAmount * losers.length);
      losers.forEach((loser) => {
        penalties.push({ playerId: loser.userId, amount: penaltyAmount });
      });
      break;
    }
    case 'CAUGHT_DROP':
      winnerPayout = pot + baseStake;
      if (caughtDroppingPlayerId) {
        penalties.push({ playerId: caughtDroppingPlayerId, amount: baseStake });
      }
      break;
  }

  const payouts: { [userId: string]: number } = {
    [roundWinnerId]: winnerPayout,
  };

  losers.forEach((loser) => {
    payouts[loser.userId] = (payouts[loser.userId] ?? 0) - baseStake;
  });

  penalties.forEach((penalty) => {
    payouts[penalty.playerId] = (payouts[penalty.playerId] ?? 0) - penalty.amount;
  });

  return { winnerPayout, penalties, payouts };
};

const mapMatchWinType = (roundEndedBy: RoundEndType): 'REEM' | 'REGULAR' | 'AUTO_TRIPLE' | 'CAUGHT_DROP' => {
  if (roundEndedBy === 'DECK_EMPTY') {
    return 'REGULAR';
  }
  return roundEndedBy;
};

const createMatchRecord = async (
  gameState: IGameState,
  settlementData: RoundSettlementData,
  mode: GameMode
) => {
  if (!gameState.roundWinnerId || !gameState.roundEndedBy) {
    return null;
  }

  const handScores = gameState.handScores ?? {};
  const match = new Match({
    tableId: gameState.tableId,
    players: gameState.players.map((player) => ({
      userId: player.userId,
      username: player.username,
      stake: gameState.baseStake,
      buyIn: player.currentBuyIn,
      payout: settlementData.payouts[player.userId] ?? 0,
      isAI: player.isAI,
      finalHandValue: handScores[player.userId] ?? 0,
    })),
    winner: gameState.roundWinnerId,
    winType: mapMatchWinType(gameState.roundEndedBy),
    pot: gameState.pot,
    winnerPayout: settlementData.winnerPayout,
    penalties: settlementData.penalties,
    status: 'completed',
    matchLog: [
      {
        event: 'MODE_SETTLEMENT',
        details: {
          mode,
          roundReference: getRoundReference(gameState),
          contestId: gameState.contestId ?? null,
        },
        timestamp: new Date(),
      },
    ],
  });

  await match.save();
  return match;
};

const settleFreeRtcRound = async (gameState: IGameState, settlementData: RoundSettlementData) => {
  const roundReference = getRoundReference(gameState);

  for (const penalty of settlementData.penalties) {
    const penalizedPlayer = gameState.players.find((player) => player.userId === penalty.playerId);
    if (!penalizedPlayer || penalizedPlayer.isAI) {
      continue;
    }

    await RtcEconomyService.rtcBurnLog(penalizedPlayer.userId, penalty.amount, GameMode.FREE_RTC_TABLE, {
      applyBalanceDebit: true,
      referenceType: 'free_rtc_penalty',
      referenceId: roundReference,
      metadata: {
        roundEndedBy: gameState.roundEndedBy,
      },
    });
  }

  const winningPlayer = gameState.players.find((player) => player.userId === gameState.roundWinnerId);
  if (winningPlayer && !winningPlayer.isAI && settlementData.winnerPayout > 0) {
    await RtcEconomyService.rtcPrizeCredit(
      winningPlayer.userId,
      settlementData.winnerPayout,
      GameMode.FREE_RTC_TABLE,
      {
        referenceType: 'free_rtc_round_result',
        referenceId: roundReference,
        metadata: {
          roundEndedBy: gameState.roundEndedBy,
        },
      }
    );
  }
};

const settleRtcTournamentRound = async (
  gameState: IGameState,
  settlementData: RoundSettlementData,
  mode: GameMode.RTC_TOURNAMENT
) => {
  const winnerId = gameState.roundWinnerId;
  if (!winnerId || settlementData.winnerPayout <= 0) {
    return;
  }

  const winner = gameState.players.find((player) => player.userId === winnerId);
  if (!winner || winner.isAI) {
    return;
  }

  await RtcEconomyService.rtcPrizeCredit(winner.userId, settlementData.winnerPayout, mode, {
    referenceType: 'rtc_tournament_round',
    referenceId: getRoundReference(gameState),
  });
};

const settleRtcSatelliteRound = async (gameState: IGameState, placements: IPlacement[]) => {
  const topPlacement = placements.find((placement) => placement.rank === 1);
  if (!topPlacement) {
    return;
  }

  const winner = gameState.players.find((player) => player.userId === topPlacement.userId);
  if (!winner || winner.isAI) {
    return;
  }

  const ticket = new TournamentTicket({
    userId: toObjectId(winner.userId),
    contestType: 'USD_CONTEST_STANDARD',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    used: false,
    issuedFromSessionId: getRoundReference(gameState),
    metadata: {
      mode: GameMode.RTC_SATELLITE,
      roundEndedBy: gameState.roundEndedBy,
    },
  });
  await ticket.save();

  await logLedgerEntry({
    userId: winner.userId,
    currency: 'RTC',
    mode: GameMode.RTC_SATELLITE,
    eventType: 'RTC_TICKET_ISSUED',
    direction: 'info',
    amount: 0,
    referenceType: 'ticket',
    referenceId: ticket._id.toString(),
    metadata: {
      contestType: ticket.contestType,
      expiresAt: ticket.expiresAt,
    },
  });
};

const settleUsdContestRound = async (
  gameState: IGameState,
  placements: IPlacement[]
): Promise<RoundSettlementData> => {
  const contestId = await resolveContestId(gameState);
  if (!contestId) {
    throw new Error('USD_CONTEST settlement requires a bound contestId.');
  }

  const result = await ContestService.completeContest({
    contestId,
    placements: placements.map((placement) => ({
      userId: placement.userId,
      rank: placement.rank,
      winType: placement.winType,
    })),
  });

  const payouts: { [userId: string]: number } = {};
  for (const player of gameState.players) {
    payouts[player.userId] = result.payoutMap[player.userId] ?? 0;
  }

  const winnerId = gameState.roundWinnerId;
  const winnerPayout = winnerId ? (payouts[winnerId] ?? 0) : 0;

  return {
    winnerPayout,
    penalties: [],
    payouts,
  };
};

export class ModeController {
  static async applyRoundEntryEconomy(gameState: IGameState, adminUserId?: string): Promise<IGameState> {
    if (gameState.roundEntryApplied) {
      return gameState;
    }

    const mode = await resolveMode(gameState);
    const contestId = await resolveContestId(gameState);
    const modeContestId = mode === GameMode.USD_CONTEST ? contestId : null;
    const roundReference = getRoundReference(gameState);
    const humanPlayers = gameState.players.filter((player) => !player.isAI);
    const hasAI = gameState.players.some((player) => player.isAI);

    const table = await Table.findById(gameState.tableId).select('isPromo');
    const isPromo = table?.isPromo ?? false;

    let hasAdmin = false;
    if (adminUserId) {
      const adminUser = await User.findById(adminUserId).select('role isAdmin');
      if (adminUser) {
        hasAdmin = roleAtLeast(resolveUserRole(adminUser.role, !!adminUser.isAdmin), 'admin');
      }
    }

    if (!hasAdmin) {
      const humanPlayerIds = humanPlayers.map((p) => p.userId);
      if (humanPlayerIds.length > 0) {
        const humanUsers = await User.find({ _id: { $in: humanPlayerIds } }).select(
          'role isAdmin'
        );
        console.log("DEBUG: Checking for admin users", humanUsers.map(u => ({ id: u._id, role: u.role, isAdmin: u.isAdmin })));
        hasAdmin = humanUsers.some((user) =>
          roleAtLeast(resolveUserRole(user.role, !!user.isAdmin), 'admin')
        );
      }
    }

    console.log("DEBUG: applyRoundEntryEconomy", { isPromo, hasAdmin, humanPlayers: humanPlayers.length });

    switch (mode) {
      case GameMode.FREE_RTC_TABLE:
        if (isPromo && hasAdmin) {
          // No player checks for promo tables with an admin
        } else {
          if (humanPlayers.length < 1) {
            throw new Error(
              'At least one human player is required to start this mode.'
            );
          }
          if (gameState.players.length < 2) {
            throw new Error(
              'FREE_RTC_TABLE requires at least two seated players.'
            );
          }
        }
        for (const player of humanPlayers) {
          await RtcEconomyService.rtcAnte(
            player.userId,
            gameState.baseStake,
            mode,
            {
              referenceType: 'free_rtc_round_entry',
              referenceId: roundReference,
            }
          );
        }
        break;
      case GameMode.RTC_TOURNAMENT:
      case GameMode.RTC_SATELLITE:
        if (humanPlayers.length < 2) {
          throw new Error('At least two human players are required to start this mode.');
        }
        if (hasAI) {
          throw new Error(`${mode} does not allow AI players.`);
        }
        for (const player of humanPlayers) {
          await RtcEconomyService.rtcTournamentEntry(player.userId, gameState.baseStake, mode, {
            referenceType: 'rtc_mode_entry',
            referenceId: roundReference,
          });
        }
        break;
      case GameMode.USD_CONTEST:
        if (humanPlayers.length < 2) {
          throw new Error('At least two human players are required to start this mode.');
        }
        if (hasAI) {
          throw new Error('USD_CONTEST does not allow AI players.');
        }
        if (!modeContestId) {
          throw new Error('USD_CONTEST requires a bound contestId before match start.');
        }
        break;
      default:
        break;
    }

    return {
      ...gameState,
      mode,
      contestId: modeContestId,
      roundEntryApplied: true,
    };
  }

  static async settleRound(gameState: IGameState): Promise<IGameState> {
    const finalizedState = finalizeRoundState(gameState);
    if (finalizedState.status !== 'round-end') {
      return finalizedState;
    }

    if (finalizedState.roundSettlementStatus === 'settled') {
      return finalizedState;
    }

    const settlementReference = getSettlementReference(finalizedState);
    const lockKey = `lock:round-settlement:${finalizedState.tableId}:${settlementReference}`;
    const lockAcquired = await redisClient.set(lockKey, 'locked', { NX: true, EX: 20 });

    if (!lockAcquired) {
      return {
        ...finalizedState,
        roundSettlementStatus: finalizedState.roundSettlementStatus ?? 'pending',
        roundSettlementReference: settlementReference,
      };
    }

    try {
      const mode = await resolveMode(finalizedState);
      const contestId = await resolveContestId(finalizedState);
      const modeContestId = mode === GameMode.USD_CONTEST ? contestId : null;
      let settlementState: IGameState = {
        ...finalizedState,
        mode,
        contestId: modeContestId,
        roundSettlementReference: settlementReference,
        roundSettlementStatus: 'pending',
      };

      if (!settlementState.roundEntryApplied) {
        settlementState = await ModeController.applyRoundEntryEconomy(settlementState);
      }

      const settlementData = calculateRoundSettlement(settlementState);
      const placements = settlementState.placements ?? [];
      let resolvedSettlementData = settlementData;

      switch (mode) {
        case GameMode.FREE_RTC_TABLE:
          await settleFreeRtcRound(settlementState, settlementData);
          break;
        case GameMode.RTC_TOURNAMENT:
          await settleRtcTournamentRound(settlementState, settlementData, GameMode.RTC_TOURNAMENT);
          break;
        case GameMode.RTC_SATELLITE:
          await settleRtcSatelliteRound(settlementState, placements);
          break;
        case GameMode.USD_CONTEST: {
          resolvedSettlementData = await settleUsdContestRound(settlementState, placements);
          break;
        }
        default:
          break;
      }

      await createMatchRecord(settlementState, resolvedSettlementData, mode);

      return {
        ...settlementState,
        payouts: resolvedSettlementData.payouts,
        roundSettlementStatus: 'settled',
        roundSettlementError: null,
        roundSettledAt: Date.now(),
      };
    } catch (error: any) {
      return {
        ...finalizedState,
        roundSettlementStatus: 'failed',
        roundSettlementError: error?.message || 'Round settlement failed.',
        roundSettlementReference: settlementReference,
      };
    } finally {
      await redisClient.del(lockKey);
    }
  }
}
