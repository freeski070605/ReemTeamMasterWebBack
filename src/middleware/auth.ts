import { Request, Response, NextFunction } from 'express';
import { verifyToken, ITokenPayload } from '../utils/jwt';


const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Get token from header
  let token = req.header("x-auth-token");

  // If not found in x-auth-token, check Authorization header
  if (!token) {
    const authHeader = req.header("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7, authHeader.length);
    }
  }

  // Check if no token
  if (!token) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  // Verify token
  try {
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ message: "Token is not valid" });
    }
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: "Token is not valid" });
  }
};

export default authMiddleware;
