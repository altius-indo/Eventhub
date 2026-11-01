import nodemailer, { type Transporter } from "nodemailer";
import type { Tx } from "@/db";
import { devOutbox } from "@/db/schema";

export type Channel = "email" | "sms" | "whatsapp";
export type OutgoingMessage = { channel: Channel; to: string; subject?: string; text: string };

export class DeliveryError extends Error {}

export interface DeliveryProvider {
  send(db: Tx, msg: OutgoingMessage): Promise<void>;
}

/** Writes messages to the dev_outbox table (viewable at /dev/outbox). Never used in production. */
export const devProvider: DeliveryProvider = {
  async send(db, msg) {
    await db.insert(devOutbox).values({ channel: msg.channel, to: msg.to, subject: msg.subject, body: msg.text });
    if (process.env.NODE_ENV !== "test") {
      console.info(`[dev-outbox] ${msg.channel} → ${msg.to}: ${msg.text}`);
    }
  },
};

export function smtpProvider(transport: Transporter, from: string): DeliveryProvider {
  return {
    async send(_db, msg) {
      if (msg.channel !== "email") throw new DeliveryError(`SMTP cannot send ${msg.channel}`);
      await transport.sendMail({ from, to: msg.to, subject: msg.subject ?? "EventHub", text: msg.text });
    },
  };
}

/** Resend's HTTP API (ADR-0021): no SMTP connection to keep open in serverless functions. */
export function resendProvider(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): DeliveryProvider {
  return {
    async send(_db, msg) {
      if (msg.channel !== "email") throw new DeliveryError(`Resend cannot send ${msg.channel}`);
      let res: Response;
      try {
        res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [msg.to], subject: msg.subject ?? "EventHub", text: msg.text }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new DeliveryError(`Resend request failed: ${(err as Error).message}`);
      }
      // The response body may echo the address but never the code; log only the status.
      if (!res.ok) throw new DeliveryError(`Resend rejected the email (HTTP ${res.status})`);
    },
  };
}

function assertDevAllowed(kind: string) {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_DELIVERY !== "1") {
    throw new DeliveryError(`${kind} is set to "dev", which is not allowed in production`);
  }
}

let smtpCache: DeliveryProvider | undefined;

export function providerFor(channel: Channel): DeliveryProvider | null {
  if (channel === "email") {
    const kind = process.env.EMAIL_PROVIDER ?? "dev";
    if (kind === "dev") {
      assertDevAllowed("EMAIL_PROVIDER");
      return devProvider;
    }
    if (kind === "smtp") {
      if (!process.env.SMTP_URL) throw new DeliveryError("SMTP_URL is not set");
      smtpCache ??= smtpProvider(
        nodemailer.createTransport(process.env.SMTP_URL),
        process.env.EMAIL_FROM ?? "EventHub <no-reply@localhost>",
      );
      return smtpCache;
    }
    if (kind === "resend") {
      if (!process.env.RESEND_API_KEY) throw new DeliveryError("RESEND_API_KEY is not set");
      return resendProvider(process.env.RESEND_API_KEY, process.env.EMAIL_FROM ?? "EventHub <onboarding@resend.dev>");
    }
    throw new DeliveryError(`Unknown EMAIL_PROVIDER "${kind}"`);
  }
  const kind = process.env.PHONE_PROVIDER ?? "dev";
  if (kind === "disabled") return null;
  if (kind === "dev") {
    assertDevAllowed("PHONE_PROVIDER");
    return devProvider;
  }
  // SMS (DLT) and WhatsApp BSP providers are added once templates are approved.
  throw new DeliveryError(`Unknown PHONE_PROVIDER "${kind}"`);
}

export function phoneLoginEnabled(): boolean {
  return (process.env.PHONE_PROVIDER ?? "dev") !== "disabled";
}

export async function sendMessage(db: Tx, msg: OutgoingMessage): Promise<void> {
  const provider = providerFor(msg.channel);
  if (!provider) throw new DeliveryError(`No provider configured for ${msg.channel}`);
  await provider.send(db, msg);
}
