import axios from 'axios';
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

const resolveFromAddress = (smtpUser?: string, mailgunDomain?: string) => {
  const explicitFrom = normalizeString(process.env.EMAIL_FROM);
  if (explicitFrom) {
    return explicitFrom;
  }

  const explicitAddress = normalizeString(process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM);
  if (explicitAddress) {
    const fromName = normalizeString(process.env.EMAIL_FROM_NAME);
    return fromName ? `${fromName} <${explicitAddress}>` : explicitAddress;
  }

  if (mailgunDomain) {
    const fromName = normalizeString(process.env.EMAIL_FROM_NAME);
    const address = `postmaster@${mailgunDomain}`;
    return fromName ? `${fromName} <${address}>` : address;
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
  const connectionTimeoutMs = Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 10000;
  const greetingTimeoutMs = Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 10000;
  const socketTimeoutMs = Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 20000;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: connectionTimeoutMs,
    greetingTimeout: greetingTimeoutMs,
    socketTimeout: socketTimeoutMs,
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

const sendWithMailgun = async (
  toEmail: string,
  resetLink: string
): Promise<SendEmailResult> => {
  const apiKey = normalizeString(process.env.MAILGUN_API_KEY);
  const domain = normalizeString(process.env.MAILGUN_DOMAIN);
  if (!apiKey || !domain) {
    return { sent: false, reason: 'mailgun_not_configured' };
  }

  const baseUrl = normalizeString(process.env.MAILGUN_BASE_URL) || 'https://api.mailgun.net';
  const from = resolveFromAddress(undefined, domain);
  if (!from) {
    return { sent: false, reason: 'from_address_missing' };
  }

  const { subject, text, html } = buildPasswordResetEmail(resetLink);
  const form = new URLSearchParams();
  form.set('from', from);
  form.set('to', toEmail);
  form.set('subject', subject);
  form.set('text', text);
  form.set('html', html);

  const timeoutMs = Number(process.env.MAILGUN_TIMEOUT_MS) || 10000;

  try {
    await axios.post(`${baseUrl}/v3/${domain}/messages`, form, {
      auth: { username: 'api', password: apiKey },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: timeoutMs,
    });
    return { sent: true };
  } catch (error) {
    console.error('[email] Mailgun send failed', error);
    return { sent: false, reason: 'send_failed' };
  }
};

export const sendPasswordResetEmail = async (
  toEmail: string,
  resetLink: string
): Promise<SendEmailResult> => {
  const hasMailgun = !!normalizeString(process.env.MAILGUN_API_KEY)
    && !!normalizeString(process.env.MAILGUN_DOMAIN);
  if (hasMailgun) {
    return sendWithMailgun(toEmail, resetLink);
  }

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
