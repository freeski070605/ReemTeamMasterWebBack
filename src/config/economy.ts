import { GameMode } from '../domain/gameMode';

export const RTC_DAILY_MINIMUM = 5000;
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

export const RTC_PURCHASE_BUNDLES: RtcPurchaseBundle[] = [
  { id: 'bundle_4_99', usdPrice: 4.99, rtcAmount: 5000, squareCatalogObjectId:"FT5HLLSMSLBB2OFWG3B25GGS"},
  { id: 'bundle_9_99', usdPrice: 9.99, rtcAmount: 12000, squareCatalogObjectId:"LD7I5MX6VZYYBEF2EMFL7F2Z" },
  { id: 'bundle_19_99', usdPrice: 19.99, rtcAmount: 30000, squareCatalogObjectId:"QJ4AZKU6UI5W7J24RGERNGTI" },
];

export const scaleStakeTierToRtc = (stakeTier: number): number => {
  return stakeTier * RTC_STAKE_MULTIPLIER;
};

export const resolveStakeAmountForMode = (stake: number, mode?: GameMode): number => {
  if (mode === GameMode.USD_CONTEST) {
    return stake;
  }
  return scaleStakeTierToRtc(stake);
};
