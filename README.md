# CheckPulse

Shopify + WooCommerce checkout & form monitor. Runs hourly synthetic checks — add-to-cart → checkout — and alerts via email the moment anything breaks, with a precise step-level diagnosis.

## Stack

- **Cloudflare Workers** — cron-triggered checks, HTTP API
- **Cloudflare D1** — SQLite at the edge for check history and incidents
- **Cloudflare KV** — active monitor cache
- **Resend** — transactional email alerts
- **Stripe** — subscription billing

## Setup

```bash
cp .dev.vars.example .dev.vars
# Fill in RESEND_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

wrangler login

# Create Cloudflare resources
wrangler d1 create checkpulse-db        # copy database_id into wrangler.toml
wrangler kv namespace create checkpulse-kv  # copy id into wrangler.toml

# Run migrations
wrangler d1 execute checkpulse-db --file=schema.sql

# Start local dev
wrangler dev
```

## Deploy

```bash
wrangler deploy
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /stores | Register a store + run initial check |
| GET | /stores | List all stores |
| GET | /stores/:id/results | Recent check results (last 48h) |
| GET | /stores/:id/incidents | Incident history |
| POST | /stores/:id/check | Trigger manual check |
| DELETE | /stores/:id | Deactivate store |
| POST | /webhooks/stripe | Stripe webhook receiver |

### Register a store

```bash
curl -X POST https://checkpulse.your-subdomain.workers.dev/stores \
  -H "Content-Type: application/json" \
  -d '{"domain": "yourstore.myshopify.com", "email": "you@example.com"}'
```

## Pricing

- **Solo** $39/mo — 1 store, hourly checks, email alerts
- **Agency** $99/mo — 3 stores, priority checks, historical dashboard
