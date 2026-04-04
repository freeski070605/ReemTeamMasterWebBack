import { Router, Request, Response, CookieOptions } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import dotenv from 'dotenv';
import User, { UserDocument } from '../models/User';
import { generateToken } from '../utils/jwt';
import { ITokenPayload } from '../utils/jwt';
import { ensureWalletForUser } from '../services/walletProvisioningService';
import { resolveUserRole, roleAtLeast } from '../constants/roles';
import { sendPasswordResetEmail } from '../utils/email';
import { buildVipPayload } from '../utils/vip';
import { resolveFrontendBaseUrl } from '../config/frontend';

dotenv.config();

const router = Router();

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0)
);
const parsedResetTtlMinutes = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
const PASSWORD_RESET_TOKEN_TTL_MINUTES =
  Number.isFinite(parsedResetTtlMinutes) && parsedResetTtlMinutes > 0
    ? parsedResetTtlMinutes
    : 30;
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_RESET_REQUEST_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';
const REFRESH_COOKIE_NAME = process.env.AUTH_REFRESH_COOKIE_NAME || 'rt_refresh_token';
const REFRESH_PERSIST_DAYS = (() => {
  const parsed = Number(process.env.AUTH_REFRESH_PERSIST_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
})();
const REFRESH_SESSION_HOURS = (() => {
  const parsed = Number(process.env.AUTH_REFRESH_SESSION_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
})();
const MAX_REFRESH_SESSIONS = (() => {
  const parsed = Number(process.env.AUTH_REFRESH_MAX_SESSIONS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
})();

type SameSiteValue = 'lax' | 'strict' | 'none';

const normalizeSameSite = (value: string | undefined): SameSiteValue => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'none') {
    return normalized;
  }
  return 'lax';
};

const AUTH_COOKIE_SAME_SITE = normalizeSameSite(
  process.env.AUTH_COOKIE_SAME_SITE || (process.env.NODE_ENV === 'production' ? 'none' : 'lax')
);
const AUTH_COOKIE_SECURE = (() => {
  if (typeof process.env.AUTH_COOKIE_SECURE === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(process.env.AUTH_COOKIE_SECURE.trim().toLowerCase());
  }
  return process.env.NODE_ENV === 'production' || AUTH_COOKIE_SAME_SITE === 'none';
})();
const AUTH_COOKIE_DOMAIN = typeof process.env.AUTH_COOKIE_DOMAIN === 'string' && process.env.AUTH_COOKIE_DOMAIN.trim().length > 0
  ? process.env.AUTH_COOKIE_DOMAIN.trim()
  : undefined;

type RefreshSessionRecord = {
  tokenHash: string;
  expiresAt: Date;
  persistent: boolean;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
};

const normalizeEmail = (value: unknown) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

const parseBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
};

const createPasswordResetToken = () => {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + (PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000));
  return { token, tokenHash, expiresAt };
};

const hashToken = (token: string) => (
  createHash('sha256').update(token).digest('hex')
);

const getRefreshSessions = (user: UserDocument): RefreshSessionRecord[] => {
  const rawSessions = (user as any).refreshSessions;
  if (!Array.isArray(rawSessions)) {
    return [];
  }

  return rawSessions.map((session: any) => ({
    tokenHash: String(session.tokenHash),
    expiresAt: new Date(session.expiresAt),
    persistent: !!session.persistent,
    userAgent: typeof session.userAgent === 'string' ? session.userAgent : null,
    createdAt: session.createdAt ? new Date(session.createdAt) : new Date(),
    lastUsedAt: session.lastUsedAt ? new Date(session.lastUsedAt) : new Date(),
  }));
};

const setRefreshSessions = (user: UserDocument, sessions: RefreshSessionRecord[]) => {
  (user as any).refreshSessions = sessions;
};

const pruneRefreshSessions = (sessions: RefreshSessionRecord[]) => {
  const now = Date.now();
  return sessions
    .filter((session) => session.expiresAt.getTime() > now)
    .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
    .slice(0, MAX_REFRESH_SESSIONS);
};

const getRefreshSessionDurationMs = (persistent: boolean) => (
  persistent
    ? REFRESH_PERSIST_DAYS * 24 * 60 * 60 * 1000
    : REFRESH_SESSION_HOURS * 60 * 60 * 1000
);

const createRefreshSession = (userAgent: string | undefined, persistent: boolean) => {
  const token = randomBytes(48).toString('hex');
  const durationMs = getRefreshSessionDurationMs(persistent);
  const now = new Date();

  return {
    token,
    session: {
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + durationMs),
      persistent,
      userAgent: userAgent?.slice(0, 255) || null,
      createdAt: now,
      lastUsedAt: now,
    } satisfies RefreshSessionRecord,
  };
};

const readCookie = (req: Request, cookieName: string) => {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  const prefix = `${cookieName}=`;
  for (const cookiePart of cookieHeader.split(';')) {
    const trimmedPart = cookiePart.trim();
    if (trimmedPart.startsWith(prefix)) {
      return decodeURIComponent(trimmedPart.slice(prefix.length));
    }
  }

  return null;
};

const getRefreshCookieOptions = (persistent: boolean): CookieOptions => ({
  httpOnly: true,
  secure: AUTH_COOKIE_SECURE,
  sameSite: AUTH_COOKIE_SAME_SITE,
  path: '/api/auth',
  ...(AUTH_COOKIE_DOMAIN ? { domain: AUTH_COOKIE_DOMAIN } : {}),
  ...(persistent ? { maxAge: getRefreshSessionDurationMs(true) } : {}),
});

const clearRefreshCookie = (res: Response) => {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: AUTH_COOKIE_SECURE,
    sameSite: AUTH_COOKIE_SAME_SITE,
    path: '/api/auth',
    ...(AUTH_COOKIE_DOMAIN ? { domain: AUTH_COOKIE_DOMAIN } : {}),
  });
};

const buildTokenPayload = (user: UserDocument): ITokenPayload => ({
  id: user._id.toString(),
  username: user.username,
  email: user.email,
  role: resolveUserRole(user.role, !!user.isAdmin),
  isAdmin: roleAtLeast(resolveUserRole(user.role, !!user.isAdmin), 'admin'),
});

const buildAuthResponse = (user: UserDocument, token: string) => {
  const resolvedRole = resolveUserRole(user.role, !!user.isAdmin);
  const vipPayload = buildVipPayload(user);

  return {
    message: 'Authenticated successfully',
    token,
    userId: user._id,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: resolvedRole,
    isAdmin: roleAtLeast(resolvedRole, 'admin'),
    vipStatus: vipPayload.vipStatus,
    vipExpiresAt: vipPayload.vipExpiresAt,
    vipSince: user.vipSince ?? null,
    isVip: vipPayload.isVip,
  };
};

const attachRefreshSession = async (
  req: Request,
  res: Response,
  user: UserDocument,
  persistent: boolean
) => {
  const refreshSession = createRefreshSession(req.get('user-agent'), persistent);
  const nextSessions = pruneRefreshSessions([...getRefreshSessions(user), refreshSession.session]);
  setRefreshSessions(user, nextSessions);
  await user.save();
  res.cookie(REFRESH_COOKIE_NAME, refreshSession.token, getRefreshCookieOptions(persistent));
};

const removeRefreshSession = async (token: string | null) => {
  if (!token) {
    return;
  }

  const tokenHash = hashToken(token);
  const user = await User.findOne({ 'refreshSessions.tokenHash': tokenHash });
  if (!user) {
    return;
  }

  const nextSessions = getRefreshSessions(user).filter((session) => session.tokenHash !== tokenHash);
  setRefreshSessions(user, nextSessions);
  await user.save();
};

const issueAuthSession = async (
  req: Request,
  res: Response,
  user: UserDocument,
  options?: { message?: string; rememberDevice?: boolean }
) => {
  const rememberDevice = options?.rememberDevice ?? true;
  const token = generateToken(buildTokenPayload(user));
  await attachRefreshSession(req, res, user, rememberDevice);

  return res.json({
    ...buildAuthResponse(user, token),
    message: options?.message || 'Authenticated successfully',
  });
};

// Register new user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;
    const rememberDevice = parseBoolean(req.body?.rememberDevice, true);
    const normalizedEmail = normalizeEmail(email);
    const isBootstrapAdmin = typeof normalizedEmail === 'string' && ADMIN_EMAILS.has(normalizedEmail);
    const role = isBootstrapAdmin ? 'superadmin' : 'user';

    let user = await User.findOne({ $or: [{ username }, { email: normalizedEmail }] });
    if (user) {
      return res.status(400).json({ message: 'User with that username or email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    user = new User({
      username,
      email: normalizedEmail,
      passwordHash,
      role,
    });
    await user.save();

    await ensureWalletForUser(user._id);

    return issueAuthSession(req, res, user, {
      rememberDevice,
      message: 'User registered successfully',
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Login user
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const rememberDevice = parseBoolean(req.body?.rememberDevice, true);
    const normalizedEmail = normalizeEmail(email);

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const currentRole = resolveUserRole(user.role, !!user.isAdmin);
    if (currentRole === 'user' && ADMIN_EMAILS.has(user.email.toLowerCase())) {
      user.role = 'superadmin';
      await user.save();
    }

    if (!user.passwordHash) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    await ensureWalletForUser(user._id);

    return issueAuthSession(req, res, user, {
      rememberDevice,
      message: 'Logged in successfully',
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const refreshToken = readCookie(req, REFRESH_COOKIE_NAME);
    if (!refreshToken) {
      clearRefreshCookie(res);
      return res.status(401).json({ message: 'Refresh session is missing.' });
    }

    const tokenHash = hashToken(refreshToken);
    const user = await User.findOne({ 'refreshSessions.tokenHash': tokenHash });
    if (!user) {
      clearRefreshCookie(res);
      return res.status(401).json({ message: 'Refresh session is invalid.' });
    }

    const refreshSessions = getRefreshSessions(user);
    const matchingSession = refreshSessions.find((session) => session.tokenHash === tokenHash) || null;

    if (!matchingSession || matchingSession.expiresAt.getTime() <= Date.now()) {
      const nextSessions = refreshSessions.filter((session) => session.tokenHash !== tokenHash);
      setRefreshSessions(user, pruneRefreshSessions(nextSessions));
      await user.save();
      clearRefreshCookie(res);
      return res.status(401).json({ message: 'Refresh session has expired.' });
    }

    const rotatedSession = createRefreshSession(req.get('user-agent'), matchingSession.persistent);
    const nextSessions = pruneRefreshSessions([
      ...refreshSessions.filter((session) => session.tokenHash !== tokenHash),
      rotatedSession.session,
    ]);
    setRefreshSessions(user, nextSessions);
    await user.save();

    res.cookie(
      REFRESH_COOKIE_NAME,
      rotatedSession.token,
      getRefreshCookieOptions(rotatedSession.session.persistent)
    );

    const token = generateToken(buildTokenPayload(user));
    return res.json({
      ...buildAuthResponse(user, token),
      message: 'Session refreshed',
    });
  } catch (error) {
    console.error(error);
    clearRefreshCookie(res);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/logout', async (req: Request, res: Response) => {
  try {
    const refreshToken = readCookie(req, REFRESH_COOKIE_NAME);
    await removeRefreshSession(refreshToken);
    clearRefreshCookie(res);
    return res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error(error);
    clearRefreshCookie(res);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email);
    let devResetLink: string | null = null;

    if (!normalizedEmail) {
      return res.status(200).json({ message: PASSWORD_RESET_REQUEST_MESSAGE });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (user && user.passwordHash) {
      const { token, tokenHash, expiresAt } = createPasswordResetToken();
      user.passwordResetTokenHash = tokenHash;
      user.passwordResetExpiresAt = expiresAt;
      await user.save();

      const resetLink = `${resolveFrontendBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[auth] Password reset link for ${normalizedEmail}: ${resetLink}`);
        devResetLink = resetLink;
      }

      void sendPasswordResetEmail(normalizedEmail, resetLink)
        .then((emailResult) => {
          if (!emailResult.sent) {
            console.warn(
              `[auth] Password reset email not sent for ${normalizedEmail} (${emailResult.reason ?? 'unknown reason'}).`
            );
          }
        })
        .catch((error) => {
          console.error(`[auth] Password reset email failed for ${normalizedEmail}`, error);
        });
    }

    return res.status(200).json({
      message: PASSWORD_RESET_REQUEST_MESSAGE,
      ...(process.env.NODE_ENV !== 'production' && devResetLink ? { resetLink: devResetLink } : {}),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!token) {
      return res.status(400).json({ message: 'Reset token is required' });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      });
    }

    const tokenHash = hashToken(token);
    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Reset token is invalid or has expired' });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(password, salt);
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    return res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;
