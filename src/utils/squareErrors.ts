import { ApiError } from './squareApi';

const getApiErrors = (error: unknown) => {
  if (!(error instanceof ApiError)) {
    return [];
  }

  return error.errors ?? [];
};

export const isSquareAuthFailure = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) {
    return false;
  }

  return error.statusCode === 401
    || getApiErrors(error).some((entry) => entry.category === 'AUTHENTICATION_ERROR');
};

export const isSquareCustomerNotFoundError = (error: unknown): boolean => {
  return getApiErrors(error).some((entry) => {
    const detail = (entry.detail || '').toLowerCase();
    return entry.code === 'CUSTOMER_NOT_FOUND'
      || (entry.code === 'NOT_FOUND' && detail.includes('customer'));
  });
};

export const isSquareCatalogObjectNotFoundError = (error: unknown): boolean => {
  return getApiErrors(error).some((entry) => {
    const detail = (entry.detail || '').toLowerCase();
    return entry.code === 'NOT_FOUND'
      && (detail.includes('catalog object') || detail.includes('item variation'));
  });
};

export const isSquareSubscriptionNotFoundError = (error: unknown): boolean => {
  return getApiErrors(error).some((entry) => {
    const detail = (entry.detail || '').toLowerCase();
    return entry.code === 'NOT_FOUND' && detail.includes('subscription');
  });
};
