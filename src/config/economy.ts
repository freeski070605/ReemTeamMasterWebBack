import { GameMode } from '../domain/gameMode';
import dotenv from 'dotenv';

dotenv.config();

export const RTC_STARTING_BALANCE = 10000;
export const RTC_DAILY_MINIMUM = 1000;
export const RTC_REFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RTC_STAKE_MULTIPLIER = 1000;

// Payout multipliers for a successful drop
export const PAYOUT_SUCCESSFUL_DROP = {
    '4_PLAYERS': 3, // 3 * stake
    '3_PLAYERS': 2, // 2 * stake
};

// Payout multiplier for "41 and 11 and Under"
export const PAYOUT_AUTO_WIN_MULTIPLIER = 9; // 9 * stake for 4 players

export interface RtcPurchaseBundle {
  id: string;
  usdPrice: number;
  rtcAmount: number;
  squareCatalogObjectId?: string;
}

const readCatalogObjectId = (envVarName: string): string | undefined => {
  const value = process.env[envVarName]?.trim();
  return value ? value : undefined;
};

export const RTC_PURCHASE_BUNDLES: RtcPurchaseBundle[] = [
  {
    id: 'bundle_4_99',
    usdPrice: 4.99,
    rtcAmount: 5000,
    squareCatalogObjectId: readCatalogObjectId('SQUARE_RTC_BUNDLE_4_99_CATALOG_OBJECT_ID'),
  },
  {
    id: 'bundle_9_99',
    usdPrice: 9.99,
    rtcAmount: 12000,
    squareCatalogObjectId: readCatalogObjectId('SQUARE_RTC_BUNDLE_9_99_CATALOG_OBJECT_ID'),
  },
  {
    id: 'bundle_19_99',
    usdPrice: 19.99,
    rtcAmount: 30000,
    squareCatalogObjectId: readCatalogObjectId('SQUARE_RTC_BUNDLE_19_99_CATALOG_OBJECT_ID'),
  },
];

export const scaleStakeTierToRtc = (stakeTier: number): number => {
  return stakeTier * RTC_STAKE_MULTIPLIER;
};

export const resolveStakeAmountForMode = (stake: number, mode?: GameMode): number => {
  if (mode === GameMode.USD_CONTEST || mode === GameMode.PRIVATE_USD_TABLE) {
    return stake;
  }
  return scaleStakeTierToRtc(stake);
};
