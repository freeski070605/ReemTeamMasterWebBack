import Invite from '../models/Invite';
import Match from '../models/Match';
import Table from '../models/Table';
import Transaction from '../models/Transaction';
import User from '../models/User';

type WindowKey = '24h' | '7d' | '30d';

type PlayerWindowStats = {
  matchesPlayed: number;
  wins: number;
  reems: number;
  regularWins: number;
  autoTripleWins: number;
  caughtDropWins: number;
  netPayout: number;
  grossPayout: number;
  biggestPayout: number;
  avgStake: number;
  highestStakeWin: number;
  depositCount: number;
  depositAmount: number;
  inviteCount: number;
  rewardedInvites: number;
  currentWinStreak: number;
  bestWinStreak: number;
};

type PlayerWindowAccumulator = PlayerWindowStats & {
  stakeTotal: number;
};

type PlayerAccumulator = {
  playerId: string;
  username: string;
  vipStatus: string;
  vipSince: string | null;
  windows: Record<WindowKey, PlayerWindowAccumulator>;
};

const windowDurations: Record<WindowKey, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

const windowKeys = Object.keys(windowDurations) as WindowKey[];

const emptyStats = (): PlayerWindowAccumulator => ({
  matchesPlayed: 0,
  wins: 0,
  reems: 0,
  regularWins: 0,
  autoTripleWins: 0,
  caughtDropWins: 0,
  netPayout: 0,
  grossPayout: 0,
  biggestPayout: 0,
  avgStake: 0,
  highestStakeWin: 0,
  depositCount: 0,
  depositAmount: 0,
  inviteCount: 0,
  rewardedInvites: 0,
  currentWinStreak: 0,
  bestWinStreak: 0,
  stakeTotal: 0
});

const toId = (value: unknown) => String(value ?? '');

const isWithinWindow = (date: Date | null | undefined, now: number, window: WindowKey) =>
  !!date && now - date.getTime() <= windowDurations[window];

const ensurePlayer = (
  store: Map<string, PlayerAccumulator>,
  input: {
    playerId: string;
    username?: string;
    vipStatus?: string;
    vipSince?: Date | null;
  }
) => {
  const existing = store.get(input.playerId);
  if (existing) {
    if (input.username && (!existing.username || existing.username === input.playerId)) {
      existing.username = input.username;
    }
    if (input.vipStatus) {
      existing.vipStatus = input.vipStatus;
    }
    if (input.vipSince) {
      existing.vipSince = input.vipSince.toISOString();
    }
    return existing;
  }

  const next: PlayerAccumulator = {
    playerId: input.playerId,
    username: input.username || input.playerId,
    vipStatus: input.vipStatus || 'NONE',
    vipSince: input.vipSince ? input.vipSince.toISOString() : null,
    windows: {
      '24h': emptyStats(),
      '7d': emptyStats(),
      '30d': emptyStats()
    }
  };

  store.set(input.playerId, next);
  return next;
};

const roundScore = (value: number) => Number(value.toFixed(2));

const scoreSignal = (input: {
  signalType: string;
  amount?: number;
  stake?: number;
  window: WindowKey;
  vipBoost?: boolean;
}) => {
  const noveltyScore = input.signalType.includes('leaderboard') ? 66 : 74;
  const performancePotentialScore = Math.min(95, 40 + Math.round((input.amount ?? 0) / 3) + Math.round((input.stake ?? 0) / 2));
  const brandFitScore = input.vipBoost ? 88 : 76;
  const urgencyScore = input.window === '24h' ? 92 : input.window === '7d' ? 68 : 45;
  const overallPriorityScore = roundScore(
    noveltyScore * 0.2 + performancePotentialScore * 0.35 + brandFitScore * 0.2 + urgencyScore * 0.25
  );

  return {
    noveltyScore,
    performancePotentialScore,
    brandFitScore,
    urgencyScore,
    overallPriorityScore
  };
};

const detectPlatforms = (signalType: string) => {
  if (signalType.includes('leaderboard') || signalType.includes('deposit')) {
    return ['instagram', 'x', 'story'];
  }

  if (signalType.includes('reem') || signalType.includes('streak')) {
    return ['instagram', 'x', 'reels'];
  }

  return ['instagram', 'x'];
};

export const buildRgeFeed = async (days = 30) => {
  const maxDays = Math.min(Math.max(days, 1), 30);
  const now = Date.now();
  const since = new Date(now - maxDays * 24 * 60 * 60 * 1000);

  const [matches, transactions, invites, users, tables] = await Promise.all([
    Match.find({
      status: 'completed',
      endTime: { $gte: since }
    })
      .sort({ endTime: 1, createdAt: 1 })
      .lean(),
    Transaction.find({
      status: 'Completed',
      date: { $gte: since }
    }).lean(),
    Invite.find({
      $or: [{ createdAt: { $gte: since } }, { lastUsedAt: { $gte: since } }]
    }).lean(),
    User.find().lean(),
    Table.find().lean()
  ]);

  const userById = new Map(users.map((user) => [toId(user._id), user]));
  const tableById = new Map(tables.map((table) => [toId(table._id), table]));
  const players = new Map<string, PlayerAccumulator>();
  const streaks = new Map<string, Record<WindowKey, { current: number; best: number }>>();

  users.forEach((user) => {
    ensurePlayer(players, {
      playerId: toId(user._id),
      username: user.username,
      vipStatus: user.vipStatus,
      vipSince: user.vipSince
    });
  });

  for (const match of matches) {
    const matchEnd = match.endTime || match.updatedAt || match.createdAt;
    if (!matchEnd) {
      continue;
    }

    const table = tableById.get(toId(match.tableId));
    const winnerId = match.winner ? toId(match.winner) : '';

    for (const player of match.players ?? []) {
      const playerId = toId(player.userId);
      const user = userById.get(playerId);
      ensurePlayer(players, {
        playerId,
        username: player.username || user?.username,
        vipStatus: user?.vipStatus,
        vipSince: user?.vipSince
      });

      if (!streaks.has(playerId)) {
        streaks.set(playerId, {
          '24h': { current: 0, best: 0 },
          '7d': { current: 0, best: 0 },
          '30d': { current: 0, best: 0 }
        });
      }

      for (const window of windowKeys) {
        if (!isWithinWindow(matchEnd, now, window)) {
          continue;
        }

        const entry = players.get(playerId);
        const streakEntry = streaks.get(playerId);
        if (!entry || !streakEntry) {
          continue;
        }

        const stats = entry.windows[window];
        stats.matchesPlayed += 1;
        stats.netPayout += Number(player.payout ?? 0);
        stats.grossPayout += Math.max(0, Number(player.payout ?? 0));
        stats.biggestPayout = Math.max(stats.biggestPayout, Number(player.payout ?? 0));
        stats.stakeTotal += Number(player.stake ?? 0);

        if (winnerId && winnerId === playerId) {
          stats.wins += 1;
          stats.highestStakeWin = Math.max(stats.highestStakeWin, Number(player.stake ?? 0));
          if (match.winType === 'REEM') {
            stats.reems += 1;
          }
          if (match.winType === 'REGULAR') {
            stats.regularWins += 1;
          }
          if (match.winType === 'AUTO_TRIPLE') {
            stats.autoTripleWins += 1;
          }
          if (match.winType === 'CAUGHT_DROP') {
            stats.caughtDropWins += 1;
          }

          streakEntry[window].current += 1;
          streakEntry[window].best = Math.max(streakEntry[window].best, streakEntry[window].current);
        } else {
          streakEntry[window].current = 0;
        }

        stats.currentWinStreak = streakEntry[window].current;
        stats.bestWinStreak = streakEntry[window].best;
        stats.avgStake = stats.matchesPlayed > 0 ? roundScore(stats.stakeTotal / stats.matchesPlayed) : 0;
      }
    }
  }

  for (const transaction of transactions) {
    const txDate = transaction.date;
    const playerId = toId(transaction.userId);
    const user = userById.get(playerId);
    const player = ensurePlayer(players, {
      playerId,
      username: user?.username,
      vipStatus: user?.vipStatus,
      vipSince: user?.vipSince
    });

    for (const window of windowKeys) {
      if (!isWithinWindow(txDate, now, window)) {
        continue;
      }

      const stats = player.windows[window];
      if (transaction.type === 'Deposit' && transaction.currency === 'USD') {
        stats.depositCount += 1;
        stats.depositAmount += Number(transaction.amount ?? 0);
      }
    }
  }

  for (const invite of invites) {
    const createdBy = invite.createdBy ? toId(invite.createdBy) : '';
    if (!createdBy) {
      continue;
    }

    const user = userById.get(createdBy);
    const player = ensurePlayer(players, {
      playerId: createdBy,
      username: user?.username,
      vipStatus: user?.vipStatus,
      vipSince: user?.vipSince
    });

    for (const window of windowKeys) {
      if (isWithinWindow(invite.createdAt, now, window)) {
        player.windows[window].inviteCount += Number(invite.uses ?? 0);
      }

      if (isWithinWindow(invite.lastUsedAt || invite.createdAt, now, window)) {
        player.windows[window].rewardedInvites += Number(invite.usedBy?.length ?? 0);
      }
    }
  }

  const playerList = [...players.values()].map((entry) => ({
    playerId: entry.playerId,
    username: entry.username,
    vipStatus: entry.vipStatus,
    vipSince: entry.vipSince,
    windows: Object.fromEntries(
      windowKeys.map((window) => [
        window,
        {
          ...entry.windows[window],
          netPayout: roundScore(entry.windows[window].netPayout),
          grossPayout: roundScore(entry.windows[window].grossPayout),
          depositAmount: roundScore(entry.windows[window].depositAmount)
        }
      ])
    )
  }));

  const buildLeaderboard = (
    metric: string,
    window: WindowKey,
    title: string,
    description: string,
    sorter: (entry: (typeof playerList)[number]) => number,
    secondaryValue?: (entry: (typeof playerList)[number]) => number | undefined,
    minimumValue = 1
  ) => ({
    metric,
    window,
    title,
    description,
    rankings: playerList
      .filter((entry) => sorter(entry) >= minimumValue)
      .sort((left, right) => sorter(right) - sorter(left))
      .slice(0, 8)
      .map((entry, index) => ({
        rank: index + 1,
        playerId: entry.playerId,
        username: entry.username,
        value: roundScore(sorter(entry)),
        secondaryValue: secondaryValue ? roundScore(secondaryValue(entry) ?? 0) : undefined,
        metadata: {
          vipStatus: entry.vipStatus
        }
      }))
  });

  const leaderboards = [
    ...windowKeys.map((window) =>
      buildLeaderboard('top_earners', window, 'Top Earners', 'Net payout by player', (entry) => entry.windows[window].netPayout)
    ),
    ...windowKeys.map((window) =>
      buildLeaderboard('most_reems', window, 'Most Reems', 'Players landing the most reems', (entry) => entry.windows[window].reems)
    ),
    ...windowKeys.map((window) =>
      buildLeaderboard(
        'biggest_payouts',
        window,
        'Biggest Payouts',
        'Largest single player payout',
        (entry) => entry.windows[window].biggestPayout
      )
    ),
    ...windowKeys.map((window) =>
      buildLeaderboard(
        'best_win_rate',
        window,
        'Best Win Rate',
        'Wins divided by matches played',
        (entry) =>
          entry.windows[window].matchesPlayed >= 5
            ? (entry.windows[window].wins / entry.windows[window].matchesPlayed) * 100
            : 0,
        (entry) => entry.windows[window].matchesPlayed,
        1
      )
    ),
    ...windowKeys.map((window) =>
      buildLeaderboard(
        'longest_streak',
        window,
        'Longest Streak',
        'Best win streak in window',
        (entry) => entry.windows[window].bestWinStreak
      )
    )
  ];

  const signals: Array<Record<string, unknown>> = [];

  matches.forEach((match) => {
    const occurredAt = match.endTime || match.updatedAt || match.createdAt;
    if (!occurredAt) {
      return;
    }

    const table = tableById.get(toId(match.tableId));
    const winnerId = match.winner ? toId(match.winner) : '';
    const winnerUser = winnerId ? userById.get(winnerId) : null;
    const winnerStats = winnerId ? players.get(winnerId) : null;
    const window: WindowKey = isWithinWindow(occurredAt, now, '24h') ? '24h' : '7d';

    if (match.winType === 'REEM' && winnerId) {
      signals.push({
        signalType: 'reem_moment',
        sourceType: 'match',
        sourceId: toId(match._id),
        playerId: winnerId,
        username: winnerUser?.username || winnerId,
        tableId: table ? toId(table._id) : '',
        tableName: table?.name || '',
        matchId: toId(match._id),
        mode: table?.mode || '',
        stake: table?.stake || 0,
        amount: match.winnerPayout,
        occurredAt: occurredAt.toISOString(),
        window,
        metadata: {
          winType: match.winType,
          pot: match.pot,
          roundNumber: match.roundNumber
        },
        scores: scoreSignal({
          signalType: 'reem_moment',
          amount: match.winnerPayout,
          stake: table?.stake || 0,
          window
        }),
        recommendedPlatforms: detectPlatforms('reem_moment')
      });
    }

    if ((match.winnerPayout ?? 0) >= 75 && winnerId) {
      signals.push({
        signalType: 'big_payout',
        sourceType: 'match',
        sourceId: `${toId(match._id)}:payout`,
        playerId: winnerId,
        username: winnerUser?.username || winnerId,
        tableId: table ? toId(table._id) : '',
        tableName: table?.name || '',
        matchId: toId(match._id),
        mode: table?.mode || '',
        stake: table?.stake || 0,
        amount: match.winnerPayout,
        occurredAt: occurredAt.toISOString(),
        window,
        metadata: {
          winType: match.winType,
          pot: match.pot
        },
        scores: scoreSignal({
          signalType: 'big_payout',
          amount: match.winnerPayout,
          stake: table?.stake || 0,
          window
        }),
        recommendedPlatforms: detectPlatforms('big_payout')
      });
    }

    if ((table?.stake ?? 0) >= 25 && winnerId) {
      signals.push({
        signalType: 'high_stakes_win',
        sourceType: 'match',
        sourceId: `${toId(match._id)}:stake`,
        playerId: winnerId,
        username: winnerUser?.username || winnerId,
        tableId: table ? toId(table._id) : '',
        tableName: table?.name || '',
        matchId: toId(match._id),
        mode: table?.mode || '',
        stake: table?.stake || 0,
        amount: match.winnerPayout,
        occurredAt: occurredAt.toISOString(),
        window,
        metadata: {
          winType: match.winType
        },
        scores: scoreSignal({
          signalType: 'high_stakes_win',
          amount: match.winnerPayout,
          stake: table?.stake || 0,
          window
        }),
        recommendedPlatforms: detectPlatforms('high_stakes_win')
      });
    }

    if (
      winnerId &&
      winnerStats &&
      winnerStats.windows[window].currentWinStreak >= 3
    ) {
      signals.push({
        signalType: 'win_streak',
        sourceType: 'match',
        sourceId: `${toId(match._id)}:streak`,
        playerId: winnerId,
        username: winnerUser?.username || winnerId,
        tableId: table ? toId(table._id) : '',
        tableName: table?.name || '',
        matchId: toId(match._id),
        mode: table?.mode || '',
        stake: table?.stake || 0,
        amount: winnerStats.windows[window].currentWinStreak,
        occurredAt: occurredAt.toISOString(),
        window,
        metadata: {
          currentWinStreak: winnerStats.windows[window].currentWinStreak
        },
        scores: scoreSignal({
          signalType: 'win_streak',
          amount: winnerStats.windows[window].currentWinStreak * 10,
          stake: table?.stake || 0,
          window
        }),
        recommendedPlatforms: detectPlatforms('win_streak')
      });
    }

    if (
      winnerId &&
      winnerUser?.vipStatus === 'ACTIVE' &&
      winnerUser.vipSince &&
      occurredAt.getTime() - winnerUser.vipSince.getTime() <= 7 * 24 * 60 * 60 * 1000
    ) {
      signals.push({
        signalType: 'vip_win',
        sourceType: 'match',
        sourceId: `${toId(match._id)}:vip`,
        playerId: winnerId,
        username: winnerUser.username,
        tableId: table ? toId(table._id) : '',
        tableName: table?.name || '',
        matchId: toId(match._id),
        mode: table?.mode || '',
        stake: table?.stake || 0,
        amount: match.winnerPayout,
        occurredAt: occurredAt.toISOString(),
        window,
        metadata: {
          vipSince: winnerUser.vipSince.toISOString()
        },
        scores: scoreSignal({
          signalType: 'vip_win',
          amount: match.winnerPayout,
          stake: table?.stake || 0,
          window,
          vipBoost: true
        }),
        recommendedPlatforms: detectPlatforms('vip_win')
      });
    }
  });

  transactions.forEach((transaction) => {
    const txDate = transaction.date;
    if (transaction.type !== 'Deposit' || transaction.currency !== 'USD' || !txDate) {
      return;
    }

    const playerId = toId(transaction.userId);
    const user = userById.get(playerId);
    const window: WindowKey = isWithinWindow(txDate, now, '24h') ? '24h' : '7d';

    if ((transaction.amount ?? 0) >= 50) {
      signals.push({
        signalType: 'deposit_momentum',
        sourceType: 'transaction',
        sourceId: toId(transaction._id),
        playerId,
        username: user?.username || playerId,
        tableId: '',
        tableName: '',
        matchId: '',
        mode: '',
        stake: 0,
        amount: transaction.amount,
        occurredAt: txDate.toISOString(),
        window,
        metadata: {
          transactionType: transaction.type
        },
        scores: scoreSignal({
          signalType: 'deposit_momentum',
          amount: transaction.amount,
          window
        }),
        recommendedPlatforms: detectPlatforms('deposit_momentum')
      });
    }
  });

  invites.forEach((invite) => {
    if (!invite.createdBy || (invite.uses ?? 0) < 2) {
      return;
    }

    const playerId = toId(invite.createdBy);
    const user = userById.get(playerId);
    const signalDate = invite.lastUsedAt || invite.createdAt;
    if (!signalDate) {
      return;
    }

    const window: WindowKey = isWithinWindow(signalDate, now, '24h') ? '24h' : '7d';
    signals.push({
      signalType: 'referral_momentum',
      sourceType: 'invite',
      sourceId: toId(invite._id),
      playerId,
      username: user?.username || playerId,
      tableId: invite.tableId ? toId(invite.tableId) : '',
      tableName: '',
      matchId: '',
      mode: '',
      stake: 0,
      amount: invite.uses,
      occurredAt: signalDate.toISOString(),
      window,
      metadata: {
        uses: invite.uses,
        maxUses: invite.maxUses
      },
      scores: scoreSignal({
        signalType: 'referral_momentum',
        amount: Number(invite.uses ?? 0) * 10,
        window
      }),
      recommendedPlatforms: detectPlatforms('referral_momentum')
    });
  });

  leaderboards.forEach((leaderboard) => {
    const leader = leaderboard.rankings[0];
    if (!leader) {
      return;
    }

    signals.push({
      signalType: `leaderboard_${leaderboard.metric}`,
      sourceType: 'leaderboard',
      sourceId: `${leaderboard.metric}:${leaderboard.window}:${leader.playerId}`,
      playerId: leader.playerId,
      username: leader.username,
      tableId: '',
      tableName: '',
      matchId: '',
      mode: '',
      stake: 0,
      amount: leader.value,
      occurredAt: new Date().toISOString(),
      window: leaderboard.window,
      metadata: {
        metric: leaderboard.metric,
        rank: leader.rank,
        secondaryValue: leader.secondaryValue
      },
      scores: scoreSignal({
        signalType: `leaderboard_${leaderboard.metric}`,
        amount: leader.value,
        window: leaderboard.window
      }),
      recommendedPlatforms: detectPlatforms(`leaderboard_${leaderboard.metric}`)
    });
  });

  signals.sort(
    (left, right) =>
      Number((right.scores as any)?.overallPriorityScore ?? 0) -
      Number((left.scores as any)?.overallPriorityScore ?? 0)
  );

  return {
    generatedAt: new Date().toISOString(),
    statsDate: new Date().toISOString().slice(0, 10),
    windows: windowKeys,
    summary: {
      totalPlayers: playerList.length,
      totalCompletedMatches: matches.length,
      totalSignals: signals.length
    },
    players: playerList,
    leaderboards,
    signals: signals.slice(0, 150)
  };
};
