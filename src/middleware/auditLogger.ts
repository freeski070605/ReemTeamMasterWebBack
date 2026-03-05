import { NextFunction, Request, Response } from 'express';
import AdminAudit from '../models/AdminAudit';
import { getAuthenticatedAdminUser } from './admin';

type AuditStateFactory = (req: Request, res: Response) => Promise<unknown> | unknown;

export interface AuditLoggerOptions {
  action: string;
  targetType: string;
  resolveTargetId?: (req: Request, res: Response) => string | undefined | null;
  captureBefore?: AuditStateFactory;
  captureAfter?: AuditStateFactory;
}

const getRequestIp = (req: Request): string => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    return forwardedFor.split(',')[0].trim();
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0];
  }
  return req.ip || '';
};

export const auditLogger = (options: AuditLoggerOptions) => async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let beforeState: unknown = null;

  if (options.captureBefore) {
    try {
      beforeState = await options.captureBefore(req, res);
    } catch (error) {
      console.error('Failed to capture audit beforeState:', error);
    }
  }

  res.on('finish', () => {
    const statusCode = res.statusCode;
    if (statusCode >= 400) {
      return;
    }

    void (async () => {
      try {
        const authUser = await getAuthenticatedAdminUser(req);
        if (!authUser) {
          return;
        }

        const afterState = options.captureAfter
          ? await options.captureAfter(req, res)
          : (res.locals.auditAfterState ?? null);
        const targetId =
          options.resolveTargetId?.(req, res) ??
          res.locals.auditTargetId ??
          req.params.id ??
          req.params.userId ??
          null;

        await AdminAudit.create({
          adminUserId: authUser.id,
          adminRole: authUser.role,
          action: options.action,
          targetType: options.targetType,
          targetId: targetId ? String(targetId) : undefined,
          beforeState,
          afterState,
          ipAddress: getRequestIp(req),
          createdAt: new Date(),
        });
      } catch (error) {
        console.error('Failed to write admin audit log:', error);
      }
    })();
  });

  return next();
};

