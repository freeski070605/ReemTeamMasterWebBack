import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';
const JWT_EXPIRES_IN = '1h'; // Token expires in 1 hour

export interface ITokenPayload {
  id: string;
  username: string;
  email: string;
}

export const generateToken = (payload: ITokenPayload): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

export const verifyToken = (token: string): ITokenPayload | null => {
  try {
    return jwt.verify(token, JWT_SECRET) as ITokenPayload;
  } catch (error) {
    return null;
  }
};
