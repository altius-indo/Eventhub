import { describe, expect, it } from "vitest";
import { DeliveryError, resendProvider } from "@/lib/delivery";
import { db } from "./helpers";

describe("Resend delivery", () => {
  it("posts the email to Resend's API with the key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    await resendProvider("re_test", "EventHub <login@example.com>", fake).send(db(), { channel: "email", to: "a@b.com", subject: "Code", text: "123456" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ from: "EventHub <login@example.com>", to: ["a@b.com"], subject: "Code", text: "123456" });
  });

  it("turns API errors into DeliveryError and refuses non-email", async () => {
    const fail = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const p = resendProvider("re_test", "x@example.com", fail);
    await expect(p.send(db(), { channel: "email", to: "a@b.com", text: "hi" })).rejects.toBeInstanceOf(DeliveryError);
    await expect(p.send(db(), { channel: "sms", to: "+919999999999", text: "hi" })).rejects.toBeInstanceOf(DeliveryError);
  });
});
