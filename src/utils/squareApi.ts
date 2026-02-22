import {
  SquareClient,
  SquareEnvironment,
  SquareError as ApiError
} from "square";
import dotenv from 'dotenv';

dotenv.config();

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const rawSquareEnvironment = (process.env.SQUARE_ENVIRONMENT || 'sandbox').trim().toLowerCase();
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

export { squareClient, ApiError, FRONTEND_URL, SQUARE_ENVIRONMENT };
