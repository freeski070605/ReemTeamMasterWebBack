import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.on('connect', () => console.log('Redis client connected...'));
redisClient.on('ready', () => console.log('Redis client ready...'));
redisClient.on('end', () => console.log('Redis client disconnected.'));
redisClient.on('reconnecting', () => console.log('Redis client reconnecting...'));
redisClient.on('error', (err) => console.error('Redis Client Error', err));

const connectRedis = async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
};

export { redisClient, connectRedis };
