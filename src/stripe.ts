import type { Env } from "./types";

export interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

export async function createCheckoutSession(
  env: Env,
  plan: "solo" | "agency",
  email?: string,
  domain?: string
): Promise<string> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe not configured");

  const priceId = plan === "agency" ? env.STRIPE_PRICE_AGENCY : env.STRIPE_PRICE_SOLO;
  if (!priceId) throw new Error("Stripe not configured");

  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: "https://adadadada321321.github.io/checkpulse/?subscribed=1",
    cancel_url: "https://adadadada321321.github.io/checkpulse/",
  });

  if (email) params.set("customer_email", email);
  if (domain) params.set("metadata[domain]", domain);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const err = (await response.json()) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? "Stripe API error");
  }

  const session = (await response.json()) as { url: string };
  return session.url;
}

export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  // Parse t=timestamp,v1=hex_sig
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => part.split("=") as [string, string])
  );

  const timestamp = parts["t"];
  const v1sig = parts["v1"];
  if (!timestamp || !v1sig) return false;

  const signedPayload = `${timestamp}.${rawBody}`;

  const keyData = new TextEncoder().encode(secret);
  const messageData = new TextEncoder().encode(signedPayload);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  const computed = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computed === v1sig;
}

export function parseStripeEvent(rawBody: string): StripeEvent {
  return JSON.parse(rawBody) as StripeEvent;
}
