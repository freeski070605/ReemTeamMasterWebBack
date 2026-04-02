import { UserDocument } from '../models/User';
import { CURRENT_SQUARE_ENVIRONMENT, SquareEnvironmentName } from './squareApi';

type EnvironmentScopedValue = {
  sandbox?: string | null;
  production?: string | null;
} | null | undefined;

const sanitizeSquareId = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getScopedValue = (
  value: EnvironmentScopedValue,
  environment: SquareEnvironmentName = CURRENT_SQUARE_ENVIRONMENT
): string | null => {
  if (!value) {
    return null;
  }

  return sanitizeSquareId(value[environment]);
};

const ensureScopedContainer = (
  value: EnvironmentScopedValue
): { sandbox: string | null; production: string | null } => {
  return {
    sandbox: sanitizeSquareId(value?.sandbox),
    production: sanitizeSquareId(value?.production),
  };
};

export const getSquareCustomerIdForCurrentEnv = (user: UserDocument): string | null => {
  const scopedValue = getScopedValue((user as any).squareCustomerIds);
  return scopedValue || sanitizeSquareId((user as any).squareCustomerId);
};

export const setSquareCustomerIdForCurrentEnv = (
  user: UserDocument,
  customerId: string | null
): void => {
  const normalized = sanitizeSquareId(customerId);
  const scoped = ensureScopedContainer((user as any).squareCustomerIds);
  scoped[CURRENT_SQUARE_ENVIRONMENT] = normalized;
  (user as any).squareCustomerIds = scoped;
  (user as any).squareCustomerId = normalized;
};

export const clearSquareCustomerIdForCurrentEnv = (user: UserDocument): void => {
  setSquareCustomerIdForCurrentEnv(user, null);
};

export const getVipSubscriptionIdForCurrentEnv = (user: UserDocument): string | null => {
  const scopedValue = getScopedValue((user as any).vipSubscriptionIds);
  return scopedValue || sanitizeSquareId((user as any).vipSubscriptionId);
};

export const setVipSubscriptionIdForCurrentEnv = (
  user: UserDocument,
  subscriptionId: string | null
): void => {
  const normalized = sanitizeSquareId(subscriptionId);
  const scoped = ensureScopedContainer((user as any).vipSubscriptionIds);
  scoped[CURRENT_SQUARE_ENVIRONMENT] = normalized;
  (user as any).vipSubscriptionIds = scoped;
  (user as any).vipSubscriptionId = normalized;
};

export const clearVipSubscriptionIdForCurrentEnv = (user: UserDocument): void => {
  setVipSubscriptionIdForCurrentEnv(user, null);
};

export const clearSquareStateForCurrentEnv = (user: UserDocument): void => {
  clearSquareCustomerIdForCurrentEnv(user);
  clearVipSubscriptionIdForCurrentEnv(user);
};

export const buildSquareCustomerLookupQuery = (customerId: string) => ({
  $or: [
    { squareCustomerId: customerId },
    { 'squareCustomerIds.sandbox': customerId },
    { 'squareCustomerIds.production': customerId },
  ],
});
