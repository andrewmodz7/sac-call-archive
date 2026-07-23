// Gmail SMTP client. Lazy singleton transport, same shape as getDrive() in
// drive.ts: nothing is constructed and no env var is required until something
// actually sends.
//
// Auth is a Gmail App Password, not the account password. Generate one at
// https://myaccount.google.com/apppasswords (requires 2FA on the account) and
// put it in GMAIL_SMTP_APP_PASSWORD. See README.

import nodemailer, { type Transporter } from "nodemailer";

let transporter: Transporter | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Whether SMTP is configured at all. Callers use this to stay quiet in
// environments that were never meant to send (local dev, for one) instead of
// failing loudly every evening.
export function isMailConfigured(): boolean {
  return Boolean(process.env.GMAIL_SMTP_USER && process.env.GMAIL_SMTP_APP_PASSWORD);
}

function getTransport(): Transporter {
  if (transporter) return transporter;

  // Explicit host/port rather than service: "gmail" so the connection settings
  // are visible here instead of hidden in a nodemailer preset. 465 + secure is
  // implicit TLS, which is the simpler of Gmail's two options.
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: requireEnv("GMAIL_SMTP_USER"),
      pass: requireEnv("GMAIL_SMTP_APP_PASSWORD"),
    },
  });
  return transporter;
}

export interface MailArgs {
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html: string;
}

// Send one message. Returns the SMTP message id on success and throws on
// failure; every caller is expected to catch, because nothing in this file is
// allowed to take down the call-archiving path.
export async function sendMail(args: MailArgs): Promise<string> {
  // Gmail rejects a From that isn't the authenticated user (or one of its
  // configured aliases), so the sender is always derived from the SMTP user.
  const from = `"SAC Call Archive" <${requireEnv("GMAIL_SMTP_USER")}>`;

  const info = await getTransport().sendMail({
    from,
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    text: args.text,
    html: args.html,
  });
  return info.messageId;
}
