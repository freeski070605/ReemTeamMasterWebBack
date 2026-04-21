import { GameMode } from '../domain/gameMode';

export type QuickPlayReason =
  | 'ready_to_start'
  | 'instant_ai_start'
  | 'filling_fast'
  | 'live_open_seat';

export interface QuickPlayTableCandidate {
  _id: string | { toString(): string };
  name?: string;
  stake: number;
  mode?: GameMode | string;
  isPrivate?: boolean;
  isPromo?: boolean;
  minPlayers?: number;
  maxPlayers: number;
  currentPlayerCount: number;
  status: 'waiting' | 'in-game';
  players?: Array<{
    isAI?: boolean;
  }>;
}

export interface QuickPlaySelection {
  table: QuickPlayTableCandidate | null;
  reason: QuickPlayReason | null;
  beginnerFriendly: boolean;
}

const getOpenSeats = (table: QuickPlayTableCandidate) =>
  Math.max(0, Number(table.maxPlayers ?? 0) - Number(table.currentPlayerCount ?? 0));

const getAiCount = (table: QuickPlayTableCandidate) =>
  Array.isArray(table.players)
    ? table.players.reduce((count, player) => count + (player?.isAI ? 1 : 0), 0)
    : 0;

const getHumanCount = (table: QuickPlayTableCandidate) =>
  Math.max(0, Number(table.currentPlayerCount ?? 0) - getAiCount(table));

const isPublicCrib = (table: QuickPlayTableCandidate) =>
  !table.isPrivate &&
  !table.isPromo &&
  (table.mode ?? GameMode.FREE_RTC_TABLE) !== GameMode.USD_CONTEST;

export const isBeginnerFriendlyTable = (table: QuickPlayTableCandidate) =>
  isPublicCrib(table) && Number(table.stake ?? 0) <= 5;

export const getQuickPlayReason = (table: QuickPlayTableCandidate): QuickPlayReason | null => {
  const openSeats = getOpenSeats(table);
  if (openSeats <= 0 || !isPublicCrib(table)) {
    return null;
  }

  const humanCount = getHumanCount(table);
  if (table.status === 'waiting' && humanCount === 1) {
    return 'ready_to_start';
  }

  if (table.status === 'waiting' && humanCount === 0) {
    return 'instant_ai_start';
  }

  if (table.status === 'waiting') {
    return 'filling_fast';
  }

  return 'live_open_seat';
};

export const scoreQuickPlayTable = (
  table: QuickPlayTableCandidate,
  options?: { beginnerMode?: boolean }
) => {
  const openSeats = getOpenSeats(table);
  if (openSeats <= 0 || !isPublicCrib(table)) {
    return Number.NEGATIVE_INFINITY;
  }

  const reason = getQuickPlayReason(table);
  if (!reason) {
    return Number.NEGATIVE_INFINITY;
  }

  const beginnerMode = options?.beginnerMode !== false;
  const humanCount = getHumanCount(table);
  const stake = Number(table.stake ?? 0);

  let score = 0;

  switch (reason) {
    case 'ready_to_start':
      score += 220;
      break;
    case 'instant_ai_start':
      score += 205;
      break;
    case 'filling_fast':
      score += 175;
      break;
    case 'live_open_seat':
      score += 140;
      break;
    default:
      break;
  }

  if (table.status === 'waiting') {
    score += 20;
  }

  score += Math.min(humanCount, 3) * 16;
  score += Math.max(0, 3 - openSeats) * 10;

  if (beginnerMode) {
    score += Math.max(0, 72 - (stake * 6));
    if (isBeginnerFriendlyTable(table)) {
      score += 26;
    }
  } else {
    score += Math.min(stake, 50);
  }

  return score;
};

export const getQuickPlayCandidates = (
  tables: QuickPlayTableCandidate[],
  options?: { beginnerMode?: boolean }
) =>
  [...tables]
    .filter((table) => isPublicCrib(table) && getOpenSeats(table) > 0)
    .sort((left, right) => {
      const scoreDelta = scoreQuickPlayTable(right, options) - scoreQuickPlayTable(left, options);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      if (left.status !== right.status) {
        return left.status === 'waiting' ? -1 : 1;
      }

      const leftHumanCount = getHumanCount(left);
      const rightHumanCount = getHumanCount(right);
      if (leftHumanCount !== rightHumanCount) {
        return rightHumanCount - leftHumanCount;
      }

      return Number(left.stake ?? 0) - Number(right.stake ?? 0);
    });

export const pickQuickPlayTable = (
  tables: QuickPlayTableCandidate[],
  options?: { beginnerMode?: boolean }
): QuickPlaySelection => {
  const candidate = getQuickPlayCandidates(tables, options)[0] ?? null;
  return {
    table: candidate,
    reason: candidate ? getQuickPlayReason(candidate) : null,
    beginnerFriendly: candidate ? isBeginnerFriendlyTable(candidate) : false,
  };
};
