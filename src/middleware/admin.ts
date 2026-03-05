import { NextFunction, Request, Response } from 'express';
import User from '../models/User';
import { ITokenPayload } from '../utils/jwt';
import { UserRole, resolveUserRole, roleAtLeast } from '../constants/roles';

const findAuthenticatedUser = async (req: Request) => {
  if (req.authUser) {
    return req.authUser;
  }

  const userId = (req.user as ITokenPayload | undefined)?.id;
  if (!userId) {
    return null;
  }

  const user = await User.findById(userId).select('username email role isAdmin isBanned isFrozen');
  if (!user) {
    return null;
  }

  const authUser = {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: resolveUserRole(user.role, !!user.isAdmin),
    isBanned: !!user.isBanned,
    isFrozen: !!user.isFrozen,
  };

  req.authUser = authUser;
  return authUser;
};

const requireRole = (minimumRole: UserRole) => async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const tokenUserId = (req.user as ITokenPayload | undefined)?.id;
  if (!tokenUserId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const authUser = await findAuthenticatedUser(req);
    if (!authUser) {
      return res.status(401).json({ message: 'Unauthorized.' });
    }

    if (!roleAtLeast(authUser.role, minimumRole)) {
      return res.status(403).json({ message: 'Forbidden: insufficient role.' });
    }

    return next();
  } catch (error) {
    console.error('Role authorization failed:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

export const requireAdmin = requireRole('admin');
export const requireFinance = requireRole('finance');
export const requireSuperAdmin = requireRole('superadmin');
export const getAuthenticatedAdminUser = findAuthenticatedUser;

export default requireAdmin;

