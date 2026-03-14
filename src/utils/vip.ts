export const VIP_STATUSES = [
  'NONE',
  'PENDING',
  'ACTIVE',
  'PAUSED',
  'CANCELED',
  'DEACTIVATED',
  'COMPLETED',
] as const;

export type VipStatus = typeof VIP_STATUSES[number];

export const VIP_ACTIVE_STATUSES = new Set<VipStatus>(['ACTIVE', 'PENDING']);

export const normalizeVipStatus = (status?: string | null): VipStatus => {
  const normalized = (status || 'NONE').toString().trim().toUpperCase();
  if ((VIP_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as VipStatus;
  }
  return 'NONE';
};

const toEndOfDay = (date: Date): Date => {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
};

export const resolveVipExpiry = (rawDate?: Date | string | null): Date | null => {
  if (!rawDate) return null;
  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (Number.isNaN(date.getTime())) return null;
  return toEndOfDay(date);
};

export const isVipActive = (status?: VipStatus | string | null, expiresAt?: Date | string | null): boolean => {
  const normalized = normalizeVipStatus(status);
  if (!VIP_ACTIVE_STATUSES.has(normalized)) {
    return false;
  }

  if (!expiresAt) {
    return true;
  }

  const resolved = resolveVipExpiry(expiresAt);
  if (!resolved) {
    return true;
  }

  return resolved.getTime() >= Date.now();
};

export const buildVipPayload = (user: { vipStatus?: VipStatus | string | null; vipExpiresAt?: Date | null }) => {
  const vipStatus = normalizeVipStatus(user.vipStatus);
  const vipExpiresAt = resolveVipExpiry(user.vipExpiresAt ?? null);
  return {
    vipStatus,
    vipExpiresAt,
    isVip: isVipActive(vipStatus, vipExpiresAt),
  };
};
