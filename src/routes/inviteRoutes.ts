import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import Invite from '../models/Invite';
import Table from '../models/Table';
import authMiddleware from '../middleware/auth';
import { verifyToken } from '../utils/jwt';
import { sendInviteEmail } from '../utils/email';

const router = Router();

const resolveFrontendBaseUrl = (req?: Request) => {
  const explicit = (process.env.FRONTEND_URL || '').trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }

  const originHeader = typeof req?.headers.origin === 'string' ? req.headers.origin : '';
  if (originHeader) {
    return originHeader.replace(/\/+$/, '');
  }

  const refererHeader = typeof req?.headers.referer === 'string' ? req.headers.referer : '';
  if (refererHeader) {
    try {
      const url = new URL(refererHeader);
      return `${url.protocol}//${url.host}`;
    } catch {
      // fall through
    }
  }

  return 'http://localhost:3000';
};

const buildInviteUrl = (code: string, req?: Request) =>
  `${resolveFrontendBaseUrl(req)}/invite/${code}`;

const getParam = (value: string | string[]): string => {
  return Array.isArray(value) ? value[0] : value;
};

const generateInviteCode = async (): Promise<string> => {
  for (let i = 0; i < 5; i += 1) {
    const code = randomBytes(4).toString('hex');
    const exists = await Invite.exists({ code });
    if (!exists) {
      return code;
    }
  }

  return `${randomBytes(4).toString('hex')}${Date.now().toString(36).slice(-2)}`;
};

const isInviteUsable = (invite: any) => {
  const expired = invite.expiresAt && invite.expiresAt.getTime() <= Date.now();
  const maxed = invite.maxUses > 0 && invite.uses >= invite.maxUses;
  return !expired && !maxed;
};

const readBearerToken = (req: Request): string | null => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length).trim();
};

router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { tableId, purpose, expiresInHours, maxUses, email } = req.body ?? {};
    const normalizedPurpose = purpose === 'lobby' ? 'lobby' : 'table';

    let resolvedTableId: mongoose.Types.ObjectId | undefined;
    if (tableId) {
      if (!mongoose.Types.ObjectId.isValid(tableId)) {
        return res.status(400).json({ message: 'Invalid tableId.' });
      }
      const table = await Table.findById(tableId);
      if (!table) {
        return res.status(404).json({ message: 'Table not found.' });
      }
      resolvedTableId = table._id;
    }

    const code = await generateInviteCode();
    const expiresHours = Number(expiresInHours);
    const expiresAt = Number.isFinite(expiresHours) && expiresHours > 0
      ? new Date(Date.now() + expiresHours * 60 * 60 * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invite = await Invite.create({
      code,
      purpose: normalizedPurpose,
      tableId: resolvedTableId,
      createdBy: (req.user as any)?.id,
      maxUses: Number.isFinite(Number(maxUses)) ? Math.max(0, Number(maxUses)) : 0,
      expiresAt,
    });

    const inviteUrl = buildInviteUrl(code, req);
    const sendTo = typeof email === 'string' ? email.trim() : '';
    if (sendTo) {
      void sendInviteEmail(sendTo, inviteUrl, (req.user as any)?.username);
    }

    return res.status(201).json({
      code,
      inviteUrl,
      invite,
    });
  } catch (error) {
    console.error('[invite] Failed to create invite', error);
    return res.status(500).json({ message: 'Failed to create invite.' });
  }
});

router.get('/:code', async (req: Request, res: Response) => {
  try {
    const code = getParam(req.params.code).trim();
    const invite = await Invite.findOne({ code });
    if (!invite || !isInviteUsable(invite)) {
      return res.status(404).json({ message: 'Invite not found or expired.' });
    }

    return res.status(200).json({
      code: invite.code,
      purpose: invite.purpose,
      tableId: invite.tableId,
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      uses: invite.uses,
    });
  } catch (error) {
    console.error('[invite] Failed to resolve invite', error);
    return res.status(500).json({ message: 'Failed to resolve invite.' });
  }
});

router.post('/:code/accept', async (req: Request, res: Response) => {
  try {
    const code = getParam(req.params.code).trim();
    const invite = await Invite.findOne({ code });
    if (!invite || !isInviteUsable(invite)) {
      return res.status(404).json({ message: 'Invite not found or expired.' });
    }

    const token = readBearerToken(req);
    const payload = token ? verifyToken(token) : null;
    const userId = payload?.id;

    const update: any = {
      $set: { lastUsedAt: new Date() },
    };

    if (userId && invite.usedBy?.some((id: any) => id.toString() === userId)) {
      // don't increment uses for repeat accepts by the same user
    } else {
      update.$inc = { uses: 1 };
      if (userId) {
        update.$addToSet = { usedBy: new mongoose.Types.ObjectId(userId) };
      }
    }

    await Invite.updateOne({ _id: invite._id }, update);

    return res.status(200).json({
      tableId: invite.tableId,
      purpose: invite.purpose,
    });
  } catch (error) {
    console.error('[invite] Failed to accept invite', error);
    return res.status(500).json({ message: 'Failed to accept invite.' });
  }
});

export default router;
