import { ITokenPayload } from "../../utils/jwt";
import { UserRole } from "../../constants/roles";

interface AuthenticatedRequestUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  isBanned: boolean;
  isFrozen: boolean;
}

declare global {
  namespace Express {
    interface User extends ITokenPayload {}

    interface Request {
      user?: User;
      authUser?: AuthenticatedRequestUser;
    }
  }
}
