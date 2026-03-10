export const USER_ROLES = ['user', 'moderator', 'finance', 'admin', 'superadmin'] as const;

export type UserRole = typeof USER_ROLES[number];

const ROLE_PRIORITY: Record<UserRole, number> = {
  user: 0,
  moderator: 1,
  finance: 2,
  admin: 3,
  superadmin: 4,
};

export const isUserRole = (value: unknown): value is UserRole => {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
};

export const resolveUserRole = (
  role: unknown,
  legacyIsAdmin: boolean = false
): UserRole => {
  if (isUserRole(role)) {
    return role;
  }
  return legacyIsAdmin ? 'admin' : 'user';
};

export const roleAtLeast = (role: UserRole, minimumRole: UserRole): boolean => {
  return ROLE_PRIORITY[role] >= ROLE_PRIORITY[minimumRole];
};

export const isAdminRole = (role: UserRole): boolean => {
  return roleAtLeast(role, 'admin');
};

export const isFinanceRole = (role: UserRole): boolean => {
  return roleAtLeast(role, 'finance');
};

export const hasAdminTabAccess = (role: UserRole): boolean => isFinanceRole(role);
