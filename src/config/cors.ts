import { isAllowedFrontendOrigin } from './frontend';

type OriginCallback = (error: Error | null, allow?: boolean) => void;

const corsOrigin = (origin: string | undefined, callback: OriginCallback) => {
  if (isAllowedFrontendOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} not allowed by CORS`));
};

export const corsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 204,
};

export const socketCorsOptions = {
  origin: corsOrigin,
  methods: ['GET', 'POST'],
  credentials: true,
};
