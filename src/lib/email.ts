import { Resend } from 'resend';

// Reusable email sender via the Resend API (https://resend.com).
//
// Configuration (env vars — see .env.example):
//   RESEND_API_KEY — API key from the Resend dashboard (starts with "re_")
//   MAIL_FROM      — verified sender address (default shown). The domain must
//                   be verified in Resend, otherwise sending will fail.
//
// When RESEND_API_KEY is not set, sendEmail() runs in a "dry run" mode: it logs
// the recipient, subject and body instead of sending, so the site stays
// demoable locally without credentials. In production, set the env var.

const RESEND_API_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('MAIL_FROM') ?? 'Ultimate Vienna <vorstand@ultimatevienna.net>';

// Read a server-side env var from import.meta.env (populated by Vite in dev
// from .env) or process.env (populated by the host in production via the Node
// adapter). Kept here so this module stays standalone.
function env(name: string): string | undefined {
  const fromImport = (import.meta.env as Record<string, string | undefined>)[name];
  if (fromImport) return fromImport;
  if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
  return undefined;
}

export function isEmailConfigured(): boolean {
  return Boolean(RESEND_API_KEY);
}

// Re-use a single Resend client across calls.
let cachedClient: Resend | null = null;

function getClient(): Resend {
  if (cachedClient) return cachedClient;
  cachedClient = new Resend(RESEND_API_KEY);
  return cachedClient;
}

export interface SendEmailResult {
  success: boolean;
  dryRun: boolean;
}

/**
 * Send an email to `to` with the given `message` body.
 * - `to`: recipient email address
 * - `message`: the email body (plain text)
 * - `subject`: optional subject line (defaults to "Ultimate Vienna")
 *
 * Never throws: returns { success, dryRun }. In dry-run mode (RESEND_API_KEY not
 * configured) it logs instead of sending.
 */
export async function sendEmail(
  to: string,
  message: string,
  subject = 'Ultimate Vienna',
): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    console.warn(
      `[email] not configured — dry run. Would send to: ${to} | subject: ${subject} | body: ${message}`,
    );
    return { success: true, dryRun: true };
  }

  try {
    const { error } = await getClient().emails.send({
      from: MAIL_FROM,
      to,
      subject,
      text: message,
    });
    if (error) {
      console.error(`[email] Resend rejected send to ${to}:`, error);
      return { success: false, dryRun: false };
    }
    console.log(`[email] sent to: ${to} | subject: ${subject}`);
    return { success: true, dryRun: false };
  } catch (err) {
    console.error(`[email] failed to send to ${to}:`, err);
    return { success: false, dryRun: false };
  }
}
