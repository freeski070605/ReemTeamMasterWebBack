import { redisClient } from '../config/redis';

const PRESENCE_ZSET_KEY = 'presence:online';
const PRESENCE_TTL_MS = 45_000;

const now = () => Date.now();

const cleanupExpired = async () => {
  const cutoff = now() - PRESENCE_TTL_MS;
  await redisClient.zRemRangeByScore(PRESENCE_ZSET_KEY, 0, cutoff);
};

export const PresenceService = {
  async markOnline(userId: string) {
    if (!userId) return;
    await redisClient.zAdd(PRESENCE_ZSET_KEY, [{ score: now(), value: userId }]);
  },

  async getOnlineCount(): Promise<number> {
    await cleanupExpired();
    return redisClient.zCard(PRESENCE_ZSET_KEY);
  },
};
