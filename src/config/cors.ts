type OriginCallback = (error: Error | null, allow?: boolean) => void;

const normalizeOrigin = (value: string) => value.replace(/\/+$/, "");

const getAllowedOrigins = () => {
  const raw =
    process.env.FRONTEND_URLS ||
    process.env.FRONTEND_URL ||
    "http://localhost:3000";

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeOrigin);
};

const isAllowedOrigin = (origin?: string) => {
  if (!origin) return true;
  return getAllowedOrigins().includes(normalizeOrigin(origin));
};

const corsOrigin = (origin: string | undefined, callback: OriginCallback) => {
  if (isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} not allowed by CORS`));
};

export const corsOptions = {
  origin: corsOrigin,
  credentials: true,
};

export const socketCorsOptions = {
  origin: corsOrigin,
  methods: ["GET", "POST"],
  credentials: true,
};
