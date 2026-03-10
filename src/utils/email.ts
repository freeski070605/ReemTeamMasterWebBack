import nodemailer from 'nodemailer';

type SendEmailResult = {
  sent: boolean;
  reason?: string;
};

const normalizeString = (value: unknown) => (
  typeof value === 'string' ? value.trim() : ''
);

const parseBoolean = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
};

const resolveFromAddress = (smtpUser?: string) => {
  const explicitFrom = normalizeString(process.env.EMAIL_FROM);
  if (explicitFrom) {
    return explicitFrom;
  }

  const explicitAddress = normalizeString(process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM);
  if (explicitAddress) {
    const fromName = normalizeString(process.env.EMAIL_FROM_NAME);
    return fromName ? `${fromName} <${explicitAddress}>` : explicitAddress;
  }

  if (smtpUser && smtpUser.includes('@')) {
    const fromName = normalizeString(process.env.EMAIL_FROM_NAME);
    return fromName ? `${fromName} <${smtpUser}>` : smtpUser;
  }

  return '';
};

const createTransporter = () => {
  const host = normalizeString(process.env.SMTP_HOST);
  if (!host) {
    return null;
  }

  const portValue = Number(process.env.SMTP_PORT);
  const secureValue = normalizeString(process.env.SMTP_SECURE);
  const parsedSecure = secureValue ? parseBoolean(secureValue) : undefined;
  const secure = parsedSecure ?? (Number.isFinite(portValue) ? portValue === 465 : false);
  const port = Number.isFinite(portValue) ? portValue : (secure ? 465 : 587);

  const user = normalizeString(process.env.SMTP_USER);
  const pass = normalizeString(process.env.SMTP_PASS);

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });
};

const buildPasswordResetEmail = (resetLink: string) => {
  const appName = normalizeString(process.env.APP_NAME) || 'ReemTeam';
  const subject = normalizeString(process.env.PASSWORD_RESET_EMAIL_SUBJECT) || `${appName} password reset`;

  const text = [
    `We received a request to reset your ${appName} password.`,
    '',
    'Use the link below to choose a new password:',
    resetLink,
    '',
    `If you did not request this, you can ignore this email.`,
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <p>We received a request to reset your ${appName} password.</p>
      <p>
        <a href="${resetLink}" style="color: #0f766e; font-weight: 600;">
          Reset your password
        </a>
      </p>
      <p>If the button above does not work, copy and paste this link into your browser:</p>
      <p style="word-break: break-all;">${resetLink}</p>
      <p>If you did not request this, you can ignore this email.</p>
    </div>
  `;

  return { subject, text, html };
};

export const sendPasswordResetEmail = async (
  toEmail: string,
  resetLink: string
): Promise<SendEmailResult> => {
  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, reason: 'smtp_not_configured' };
  }

  const smtpUser = normalizeString(process.env.SMTP_USER);
  const from = resolveFromAddress(smtpUser);
  if (!from) {
    return { sent: false, reason: 'from_address_missing' };
  }

  const { subject, text, html } = buildPasswordResetEmail(resetLink);

  try {
    await transporter.sendMail({
      from,
      to: toEmail,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (error) {
    console.error('[email] Failed to send password reset email', error);
    return { sent: false, reason: 'send_failed' };
  }
};
