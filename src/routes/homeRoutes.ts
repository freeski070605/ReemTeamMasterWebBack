import { Router, Request, Response } from 'express';
import Contest from '../models/Contest';
import Table from '../models/Table';
import { buildRgeFeed } from '../services/rgeFeedService';

const router = Router();

const HOME_LEADERBOARD_WINDOW = '7d';

router.get('/overview', async (_req: Request, res: Response) => {
  try {
    const [tables, contests, feed] = await Promise.all([
      Table.find()
        .select('name stake mode isPrivate currentPlayerCount maxPlayers status activeContestId')
        .lean(),
      Contest.find()
        .select('contestId mode entryFee playerCount prizePool status participants')
        .lean(),
      buildRgeFeed(7),
    ]);

    const featuredTable =
      [...tables].sort((a, b) => {
        if (a.status !== b.status) {
          return a.status === 'in-game' ? -1 : 1;
        }
        if ((a.currentPlayerCount ?? 0) !== (b.currentPlayerCount ?? 0)) {
          return (b.currentPlayerCount ?? 0) - (a.currentPlayerCount ?? 0);
        }
        return (b.stake ?? 0) - (a.stake ?? 0);
      })[0] ?? null;

    const featuredContest =
      [...contests]
        .filter((contest) => contest.status === 'open' || contest.status === 'locked' || contest.status === 'in-progress')
        .sort((a, b) => {
          const prizeDelta = Number(b.prizePool ?? 0) - Number(a.prizePool ?? 0);
          if (prizeDelta !== 0) {
            return prizeDelta;
          }

          const seatsLeftA =
            Number(a.playerCount ?? 0) - (Array.isArray(a.participants) ? a.participants.length : 0);
          const seatsLeftB =
            Number(b.playerCount ?? 0) - (Array.isArray(b.participants) ? b.participants.length : 0);
          return seatsLeftA - seatsLeftB;
        })[0] ?? null;

    const pickLeaderboard = (metric: string) =>
      feed.leaderboards.find((leaderboard) => leaderboard.metric === metric && leaderboard.window === HOME_LEADERBOARD_WINDOW) ??
      null;

    const openContests = contests.filter((contest) => contest.status === 'open').length;
    const liveContests = contests.filter((contest) => contest.status === 'in-progress').length;
    const totalContestSeats = contests.reduce((sum, contest) => sum + Number(contest.playerCount ?? 0), 0);
    const filledContestSeats = contests.reduce(
      (sum, contest) => sum + (Array.isArray(contest.participants) ? contest.participants.length : 0),
      0
    );

    res.status(200).json({
      generatedAt: feed.generatedAt,
      tableSummary: {
        totalTables: tables.length,
        activeTables: tables.filter((table) => table.status === 'in-game').length,
        rtcTables: tables.filter((table) => table.mode !== 'USD_CONTEST' && !table.isPrivate).length,
        cashTables: tables.filter((table) => table.mode === 'USD_CONTEST').length,
        privateTables: tables.filter((table) => !!table.isPrivate).length,
      },
      contestSummary: {
        totalContests: contests.length,
        openContests,
        liveContests,
        seatsFilled: filledContestSeats,
        totalSeats: totalContestSeats,
        totalPrizePool: contests.reduce((sum, contest) => sum + Number(contest.prizePool ?? 0), 0),
      },
      featuredTable,
      featuredContest,
      leaderboards: {
        topEarners: pickLeaderboard('top_earners'),
        mostReems: pickLeaderboard('most_reems'),
        bestWinRate: pickLeaderboard('best_win_rate'),
        longestStreak: pickLeaderboard('longest_streak'),
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: error?.message || 'Failed to load home overview.' });
  }
});

export default router;
