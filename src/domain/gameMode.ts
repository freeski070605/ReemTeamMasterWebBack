export enum GameMode {
  FREE_RTC_TABLE = 'FREE_RTC_TABLE',
  RTC_TOURNAMENT = 'RTC_TOURNAMENT',
  RTC_SATELLITE = 'RTC_SATELLITE',
  USD_CONTEST = 'USD_CONTEST',
}

export const DEFAULT_GAME_MODE = GameMode.FREE_RTC_TABLE;

export const ALL_GAME_MODES: GameMode[] = Object.values(GameMode);

