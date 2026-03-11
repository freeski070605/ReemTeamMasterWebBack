import RecentPlayer from '../models/RecentPlayer';

type RecentPlayerInput = {
  userId: string;
  username: string;
  avatarUrl?: string;
  isAI: boolean;
};

export const RecentPlayerService = {
  async recordRecentPlayers(players: RecentPlayerInput[]) {
    const humans = players.filter((player) => !player.isAI);
    if (humans.length <= 1) {
      return;
    }

    const now = new Date();
    const ops = [];

    for (const player of humans) {
      for (const other of humans) {
        if (player.userId === other.userId) {
          continue;
        }

        ops.push({
          updateOne: {
            filter: { userId: player.userId, recentUserId: other.userId },
            update: {
              $set: {
                recentUsername: other.username,
                recentAvatarUrl: other.avatarUrl ?? null,
                lastPlayedAt: now,
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (ops.length > 0) {
      await RecentPlayer.bulkWrite(ops, { ordered: false });
    }
  },
};
