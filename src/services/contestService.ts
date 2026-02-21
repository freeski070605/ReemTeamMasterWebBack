import mongoose from 'mongoose';
import Contest, { ContestDocument } from '../models/Contest';
import TournamentTicket, { TournamentTicketDocument } from '../models/TournamentTicket';
import { FinancialService } from './financialService';
import { logLedgerEntry } from './ledgerService';
import { GameMode } from '../domain/gameMode';

export interface ContestPlacementInput {
  userId: string;
  rank: number;
  winType?: string;
}

interface CreateContestInput {
  entryFee: number;
  playerCount: number;
  platformFee?: number;
  payoutStructure?: Array<{ rank: number; amount?: number; percentage?: number }>;
}

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const assertPositive = (value: number, field: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
};

const normalizePlayerCount = (value: number): number => {
  if (!Number.isInteger(value) || value < 2 || value > 4) {
    throw new Error('playerCount must be an integer between 2 and 4.');
  }
  return value;
};

const normalizePlatformFee = (platformFee: number | undefined, totalCollected: number): number => {
  const fee = platformFee ?? 0;
  if (!Number.isFinite(fee) || fee < 0) {
    throw new Error('platformFee must be a non-negative number.');
  }
  if (fee > totalCollected) {
    throw new Error('platformFee cannot exceed total contest collection.');
  }
  return roundCurrency(fee);
};

const findContest = async (contestIdOrDbId: string): Promise<ContestDocument | null> => {
  const byContestId = await Contest.findOne({ contestId: contestIdOrDbId });
  if (byContestId) return byContestId;

  if (mongoose.Types.ObjectId.isValid(contestIdOrDbId)) {
    return Contest.findById(contestIdOrDbId);
  }

  return null;
};

const findTicketForUser = async (
  ticketIdOrDbId: string,
  userId: string
): Promise<TournamentTicketDocument | null> => {
  let ticket: TournamentTicketDocument | null = null;

  if (mongoose.Types.ObjectId.isValid(ticketIdOrDbId)) {
    ticket = await TournamentTicket.findById(ticketIdOrDbId);
  }

  if (!ticket) {
    ticket = await TournamentTicket.findOne({
      _id: ticketIdOrDbId,
      userId: new mongoose.Types.ObjectId(userId),
    });
  }

  if (!ticket) {
    return null;
  }

  if (ticket.userId.toString() !== userId) {
    return null;
  }

  return ticket;
};

const sanitizePayoutRules = (
  payoutStructure: CreateContestInput['payoutStructure'],
  prizePool: number
): Array<{ rank: number; amount: number; percentage?: number }> => {
  if (!payoutStructure || payoutStructure.length === 0) {
    return [];
  }

  const normalized = payoutStructure
    .map((rule) => {
      if (!Number.isInteger(rule.rank) || rule.rank < 1) {
        throw new Error('Each payout rule rank must be an integer >= 1.');
      }
      const amount = rule.amount ?? 0;
      const percentage = rule.percentage;
      if (amount < 0) {
        throw new Error('Payout amount must be >= 0.');
      }
      if (percentage !== undefined && (percentage < 0 || percentage > 100)) {
        throw new Error('Payout percentage must be between 0 and 100.');
      }

      let resolvedAmount = amount;
      if (resolvedAmount === 0 && percentage !== undefined) {
        resolvedAmount = roundCurrency(prizePool * (percentage / 100));
      }

      return {
        rank: rule.rank,
        amount: roundCurrency(Math.max(0, resolvedAmount)),
        percentage,
      };
    })
    .sort((a, b) => a.rank - b.rank);

  const total = normalized.reduce((sum, rule) => sum + rule.amount, 0);
  if (total === 0) {
    return [];
  }

  if (total <= prizePool) {
    return normalized;
  }

  const scale = prizePool / total;
  return normalized.map((rule) => ({
    ...rule,
    amount: roundCurrency(rule.amount * scale),
  }));
};

const computePayoutMap = (
  contest: ContestDocument,
  placements: ContestPlacementInput[]
): { [userId: string]: number } => {
  const ranked = [...placements].sort((a, b) => a.rank - b.rank);
  const payoutMap: { [userId: string]: number } = {};
  const prizePool = contest.prizePool;

  if (!contest.payoutStructure || contest.payoutStructure.length === 0) {
    const winner = ranked.find((p) => p.rank === 1);
    if (winner) {
      payoutMap[winner.userId] = roundCurrency(prizePool);
    }
    return payoutMap;
  }

  const payoutRules = contest.payoutStructure
    .map((rule: any) => ({ rank: rule.rank, amount: rule.amount }))
    .filter((rule: any) => rule.amount > 0)
    .sort((a: any, b: any) => a.rank - b.rank);

  let remaining = prizePool;
  for (const rule of payoutRules) {
    const recipient = ranked.find((p) => p.rank === rule.rank);
    if (!recipient) continue;
    const amount = Math.min(remaining, roundCurrency(rule.amount));
    if (amount <= 0) continue;
    payoutMap[recipient.userId] = (payoutMap[recipient.userId] ?? 0) + amount;
    remaining = roundCurrency(remaining - amount);
  }

  if (remaining > 0) {
    const winner = ranked.find((p) => p.rank === 1);
    if (winner) {
      payoutMap[winner.userId] = roundCurrency((payoutMap[winner.userId] ?? 0) + remaining);
    }
  }

  return payoutMap;
};

export class ContestService {
  static async listContests(params?: { status?: string; mode?: GameMode }) {
    const query: Record<string, unknown> = {};
    if (params?.status) {
      query.status = params.status;
    }
    if (params?.mode) {
      query.mode = params.mode;
    }

    return Contest.find(query).sort({ createdAt: -1 });
  }

  static async createContest(input: CreateContestInput) {
    assertPositive(input.entryFee, 'entryFee');
    const playerCount = normalizePlayerCount(input.playerCount);
    const totalCollected = roundCurrency(input.entryFee * playerCount);
    const platformFee = normalizePlatformFee(input.platformFee, totalCollected);
    const prizePool = roundCurrency(totalCollected - platformFee);

    const payoutStructure = sanitizePayoutRules(input.payoutStructure, prizePool);
    const contest = new Contest({
      mode: GameMode.USD_CONTEST,
      entryFee: roundCurrency(input.entryFee),
      playerCount,
      prizePool,
      platformFee,
      status: 'open',
      payoutStructure,
      participants: [],
    });

    await contest.save();
    return contest;
  }

  static async joinContestWithUsd(contestId: string, userId: string) {
    const contest = await findContest(contestId);
    if (!contest) {
      throw new Error('Contest not found.');
    }
    if (contest.mode !== GameMode.USD_CONTEST) {
      throw new Error('Only USD_CONTEST is currently supported by this endpoint.');
    }
    if (contest.status !== 'open') {
      throw new Error(`Contest is not joinable in status "${contest.status}".`);
    }

    const alreadyJoined = contest.participants.some((participant) => participant.toString() === userId);
    if (alreadyJoined) {
      return { contest, alreadyJoined: true };
    }

    if (contest.participants.length >= contest.playerCount) {
      throw new Error('Contest is full.');
    }

    await FinancialService.contestEntry(userId, contest.entryFee, contest.contestId, {
      joinMethod: 'usd',
    });

    contest.participants.push(new mongoose.Types.ObjectId(userId));
    if (contest.participants.length >= contest.playerCount && contest.status === 'open') {
      contest.status = 'locked';
      await FinancialService.logPrizePoolLock({
        contestId: contest.contestId,
        prizePool: contest.prizePool,
        entryFee: contest.entryFee,
        platformFee: contest.platformFee,
        playerCount: contest.playerCount,
      });
    }

    await contest.save();
    return { contest, alreadyJoined: false };
  }

  static async redeemTicketAndJoinContest(params: {
    contestId: string;
    userId: string;
    ticketId: string;
  }) {
    const contest = await findContest(params.contestId);
    if (!contest) {
      throw new Error('Contest not found.');
    }
    if (contest.mode !== GameMode.USD_CONTEST) {
      throw new Error('Ticket redemption only supports USD contests.');
    }
    if (contest.status !== 'open') {
      throw new Error(`Contest is not joinable in status "${contest.status}".`);
    }
    if (contest.participants.length >= contest.playerCount) {
      throw new Error('Contest is full.');
    }

    const ticket = await findTicketForUser(params.ticketId, params.userId);
    if (!ticket) {
      throw new Error('Ticket not found for user.');
    }
    if (ticket.used) {
      throw new Error('Ticket has already been used.');
    }
    if (ticket.targetMode !== GameMode.USD_CONTEST) {
      throw new Error('Ticket is not valid for USD contest mode.');
    }
    if (ticket.expiresAt.getTime() < Date.now()) {
      throw new Error('Ticket has expired.');
    }

    const alreadyJoined = contest.participants.some((participant) => participant.toString() === params.userId);
    if (!alreadyJoined) {
      contest.participants.push(new mongoose.Types.ObjectId(params.userId));
    }

    ticket.used = true;
    ticket.usedAt = new Date();
    ticket.metadata = {
      ...(ticket.metadata || {}),
      redeemedContestId: contest.contestId,
      redeemedAt: ticket.usedAt,
    };

    if (contest.participants.length >= contest.playerCount && contest.status === 'open') {
      contest.status = 'locked';
      await FinancialService.logPrizePoolLock({
        contestId: contest.contestId,
        prizePool: contest.prizePool,
        entryFee: contest.entryFee,
        platformFee: contest.platformFee,
        playerCount: contest.playerCount,
      });
    }

    await contest.save();
    await ticket.save();

    await logLedgerEntry({
      userId: params.userId,
      currency: 'RTC',
      mode: GameMode.USD_CONTEST,
      eventType: 'RTC_TICKET_REDEEMED',
      direction: 'info',
      amount: 0,
      referenceType: 'contest',
      referenceId: contest.contestId,
      metadata: {
        ticketId: ticket._id.toString(),
      },
    });

    return { contest, ticket };
  }

  static async startContest(contestId: string) {
    const contest = await findContest(contestId);
    if (!contest) {
      throw new Error('Contest not found.');
    }
    if (contest.status !== 'locked' && contest.status !== 'open') {
      throw new Error(`Contest cannot be started from status "${contest.status}".`);
    }
    if (contest.participants.length !== contest.playerCount) {
      throw new Error(`Contest requires exactly ${contest.playerCount} participants to start.`);
    }

    if (contest.status === 'open') {
      contest.status = 'locked';
      await FinancialService.logPrizePoolLock({
        contestId: contest.contestId,
        prizePool: contest.prizePool,
        entryFee: contest.entryFee,
        platformFee: contest.platformFee,
        playerCount: contest.playerCount,
      });
    }

    contest.status = 'in-progress';
    contest.startedAt = new Date();
    await contest.save();
    return contest;
  }

  static async completeContest(params: {
    contestId: string;
    placements: ContestPlacementInput[];
  }) {
    const contest = await findContest(params.contestId);
    if (!contest) {
      throw new Error('Contest not found.');
    }
    if (contest.status !== 'in-progress' && contest.status !== 'locked') {
      throw new Error(`Contest cannot be completed from status "${contest.status}".`);
    }

    const participantIds = new Set(contest.participants.map((id) => id.toString()));
    if (participantIds.size !== contest.playerCount) {
      throw new Error('Contest does not have a full participant set.');
    }

    const placements = [...params.placements]
      .filter((placement) => participantIds.has(placement.userId))
      .sort((a, b) => a.rank - b.rank);

    if (placements.length === 0) {
      throw new Error('No valid placements were provided for contest completion.');
    }

    const payoutMap = computePayoutMap(contest, placements);
    const payoutEntries = Object.entries(payoutMap).filter(([, amount]) => amount > 0);
    for (const [userId, amount] of payoutEntries) {
      await FinancialService.payoutCredit(userId, amount, contest.contestId, {
        placements,
      });
    }

    contest.status = 'completed';
    contest.endedAt = new Date();
    await contest.save();

    return {
      contest,
      payoutMap,
      placements,
    };
  }

  static async getUserTickets(userId: string, options?: { includeUsed?: boolean }) {
    const query: Record<string, unknown> = {
      userId: new mongoose.Types.ObjectId(userId),
    };
    if (!options?.includeUsed) {
      query.used = false;
    }
    return TournamentTicket.find(query).sort({ expiresAt: 1, createdAt: -1 });
  }
}
