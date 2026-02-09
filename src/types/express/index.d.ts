import { ITokenPayload } from "../../utils/jwt";

declare global {
  namespace Express {
    interface User extends ITokenPayload {}

    interface Request {
      user?: User;
    }
  }
}
