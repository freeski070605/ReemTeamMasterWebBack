import type { Request } from 'express';

const DEFAULT_LOCAL_FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_PRODUCTION_FRONTEND_URL = 'https://reemteamapp.com';
const DEFAULT_ALLOWED_FRONTEND_URLS = [
  DEFAULT_LOCAL_FRONTEND_URL,
  'http://127.0.0.1:3000',
  DEFAULT_PRODUCTION_FRONTEND_URL,
  'https://www.reemteamapp.com',
];

const normalizeOrigin = (value: string) => value.replace(/\/+$/, '');

const toOrigin = (value: string) => {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    return normalizeOrigin(parsed.origin);
  } catch {
    return null;
  }
};

const getConfiguredFrontendOrigins = () => {
  const rawValues = [process.env.FRONTEND_URLS || '', process.env.FRONTEND_URL || ''];

  return rawValues
    .flatMap((value) => value.split(','))
    .map((value) => toOrigin(value))
    .filter((value): value is string => Boolean(value));
};

export const getAllowedFrontendOrigins = () => {
  const merged = [...getConfiguredFrontendOrigins(), ...DEFAULT_ALLOWED_FRONTEND_URLS]
    .map((value) => toOrigin(value))
    .filter((value): value is string => Boolean(value));

  return [...new Set(merged)];
};

export const getPrimaryFrontendUrl = () => {
  const configuredOrigins = getConfiguredFrontendOrigins();
  if (configuredOrigins.length > 0) {
    return configuredOrigins[0];
  }

  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PRODUCTION_FRONTEND_URL
    : DEFAULT_LOCAL_FRONTEND_URL;
};

export const isAllowedFrontendOrigin = (origin?: string) => {
  if (!origin) {
    return true;
  }

  const normalizedOrigin = toOrigin(origin);
  return normalizedOrigin ? getAllowedFrontendOrigins().includes(normalizedOrigin) : false;
};

export const resolveFrontendBaseUrl = (req?: Request) => {
  const requestOrigin = typeof req?.headers.origin === 'string'
    ? toOrigin(req.headers.origin)
    : null;
  if (requestOrigin) {
    return requestOrigin;
  }

  const refererHeader = typeof req?.headers.referer === 'string' ? req.headers.referer : '';
  const refererOrigin = refererHeader ? toOrigin(refererHeader) : null;
  if (refererOrigin) {
    return refererOrigin;
  }

  return getPrimaryFrontendUrl();
};
