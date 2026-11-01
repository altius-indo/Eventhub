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
