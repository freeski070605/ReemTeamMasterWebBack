export const RTC_DAILY_MINIMUM = 1000;
export const RTC_REFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RTC_STAKE_MULTIPLIER = 1000;

export interface RtcPurchaseBundle {
  id: string;
  usdPrice: number;
  rtcAmount: number;
}

export const RTC_PURCHASE_BUNDLES: RtcPurchaseBundle[] = [
  { id: 'bundle_4_99', usdPrice: 4.99, rtcAmount: 5000 },
  { id: 'bundle_9_99', usdPrice: 9.99, rtcAmount: 12000 },
  { id: 'bundle_19_99', usdPrice: 19.99, rtcAmount: 30000 },
];

export const scaleStakeTierToRtc = (stakeTier: number): number => {
  return stakeTier * RTC_STAKE_MULTIPLIER;
};

