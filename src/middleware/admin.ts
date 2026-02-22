import { NextFunction, Request, Response } from 'express';
import User from '../models/User';
import { ITokenPayload } from '../utils/jwt';

const adminMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req.user as ITokenPayload | undefined)?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: User ID not found.' });
  }

  try {
    const user = await User.findById(userId).select('isAdmin');
    if (!user?.isAdmin) {
      return res.status(403).json({ message: 'Admin access required.' });
    }
    next();
  } catch (error) {
    console.error('Admin authorization failed:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

export default adminMiddleware;
