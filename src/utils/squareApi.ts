import {
  SquareClient,
  SquareEnvironment,
  SquareError as ApiError
} from "square";
import dotenv from 'dotenv';

dotenv.config();

const SQUARE_ACCESS_TOKEN = (process.env.SQUARE_ACCESS_TOKEN || '').trim();
const rawSquareEnvironment = (process.env.SQUARE_ENVIRONMENT || 'sandbox').trim().toLowerCase();
const CURRENT_SQUARE_ENVIRONMENT = rawSquareEnvironment === 'production'
  ? 'production'
  : 'sandbox';
const SQUARE_ENVIRONMENT = rawSquareEnvironment === 'production'
  ? SquareEnvironment.Production
  : SquareEnvironment.Sandbox;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

if (!SQUARE_ACCESS_TOKEN) {
  console.warn('SQUARE_ACCESS_TOKEN is not set. Square API functionality will be limited.');
}

const squareClient = new SquareClient({
  token: SQUARE_ACCESS_TOKEN,
  environment: SQUARE_ENVIRONMENT,
});

export type SquareEnvironmentName = typeof CURRENT_SQUARE_ENVIRONMENT;

export { squareClient, ApiError, CURRENT_SQUARE_ENVIRONMENT, FRONTEND_URL, SQUARE_ENVIRONMENT };
