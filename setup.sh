#!/bin/bash
# CheckPulse one-shot setup
# Usage: CLOUDFLARE_API_TOKEN=your_token_here ./setup.sh
# Get a token at: https://dash.cloudflare.com/profile/api-tokens
#   → Create Token → Edit Cloudflare Workers (template)

set -e

WRANGLER="./node_modules/.bin/wrangler"
WRANGLER_TOML="wrangler.toml"

# ── Preflight ─────────────────────────────────────────────────────────────────

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo ""
  echo "❌  CLOUDFLARE_API_TOKEN is not set."
  echo ""
  echo "   1. Visit https://dash.cloudflare.com/profile/api-tokens"
  echo "   2. Click Create Token → Edit Cloudflare Workers"
  echo "   3. Create token, copy it"
  echo "   4. Re-run: CLOUDFLARE_API_TOKEN=paste_token_here ./setup.sh"
  echo ""
  exit 1
fi

export CLOUDFLARE_API_TOKEN

if ! command -v jq &> /dev/null; then
  echo "❌  jq is required. Install with: brew install jq"
  exit 1
fi

echo ""
echo "🔍  Looking up Cloudflare account..."
ACCOUNT_JSON=$($WRANGLER whoami --json 2>/dev/null || echo "")
if [ -z "$ACCOUNT_JSON" ]; then
  # Fall back to non-JSON whoami
  echo "   (run: wrangler whoami to verify your token)"
else
  CLOUDFLARE_ACCOUNT_ID=$(echo "$ACCOUNT_JSON" | jq -r '.accounts[0].id // empty' 2>/dev/null || true)
fi

if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  echo ""
  echo "⚠️   Could not auto-detect account ID."
  echo "   Find it at: https://dash.cloudflare.com — it's in the URL after login."
  echo "   Re-run: CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy ./setup.sh"
  echo ""
  exit 1
fi

export CLOUDFLARE_ACCOUNT_ID
echo "   Account ID: $CLOUDFLARE_ACCOUNT_ID"

# ── D1 Database ───────────────────────────────────────────────────────────────

echo ""
echo "📦  Creating D1 database 'checkpulse-db'..."

# Check if it already exists
EXISTING_D1=$($WRANGLER d1 list --json 2>/dev/null | jq -r '.[] | select(.name=="checkpulse-db") | .uuid' 2>/dev/null || true)

if [ -n "$EXISTING_D1" ]; then
  D1_ID="$EXISTING_D1"
  echo "   ✅ Already exists: $D1_ID"
else
  D1_OUTPUT=$($WRANGLER d1 create checkpulse-db 2>&1)
  D1_ID=$(echo "$D1_OUTPUT" | grep -E 'database_id\s*=' | tail -1 | sed 's/.*=\s*"\(.*\)"/\1/' | tr -d ' "')
  if [ -z "$D1_ID" ]; then
    echo "   ❌ Failed to create D1. Output:"
    echo "$D1_OUTPUT"
    exit 1
  fi
  echo "   ✅ Created: $D1_ID"
fi

# ── KV Namespace ──────────────────────────────────────────────────────────────

echo ""
echo "🗄   Creating KV namespace 'CHECKPULSE_KV'..."

EXISTING_KV=$($WRANGLER kv:namespace list --json 2>/dev/null | jq -r '.[] | select(.title | contains("CHECKPULSE_KV")) | .id' 2>/dev/null | head -1 || true)

if [ -n "$EXISTING_KV" ]; then
  KV_ID="$EXISTING_KV"
  echo "   ✅ Already exists: $KV_ID"
else
  KV_OUTPUT=$($WRANGLER kv:namespace create CHECKPULSE_KV 2>&1)
  KV_ID=$(echo "$KV_OUTPUT" | grep -E '"id"' | tail -1 | sed 's/.*"id":\s*"\(.*\)".*/\1/')
  if [ -z "$KV_ID" ]; then
    echo "   ❌ Failed to create KV. Output:"
    echo "$KV_OUTPUT"
    exit 1
  fi
  echo "   ✅ Created: $KV_ID"
fi

# ── Update wrangler.toml ──────────────────────────────────────────────────────

echo ""
echo "✏️   Updating wrangler.toml with real IDs..."

if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/REPLACE_WITH_D1_DATABASE_ID/$D1_ID/" "$WRANGLER_TOML"
  sed -i '' "s/REPLACE_WITH_KV_NAMESPACE_ID/$KV_ID/" "$WRANGLER_TOML"
else
  sed -i "s/REPLACE_WITH_D1_DATABASE_ID/$D1_ID/" "$WRANGLER_TOML"
  sed -i "s/REPLACE_WITH_KV_NAMESPACE_ID/$KV_ID/" "$WRANGLER_TOML"
fi

echo "   ✅ wrangler.toml updated"

# ── Run DB Migration ──────────────────────────────────────────────────────────

echo ""
echo "🗃   Running DB migration..."
$WRANGLER d1 execute checkpulse-db --file=schema.sql
echo "   ✅ Migration complete"

# ── Resend API Key ────────────────────────────────────────────────────────────

echo ""
echo "📧  Resend API key setup (optional — skip to set later):"
echo "   Get a free key at: https://resend.com (send up to 3,000 emails/month free)"
read -r -p "   Paste Resend API key (or press Enter to skip): " RESEND_KEY

if [ -n "$RESEND_KEY" ]; then
  echo "$RESEND_KEY" | $WRANGLER secret put RESEND_API_KEY
  echo "   ✅ Resend API key stored"
else
  echo "   ⏭  Skipped — set later with: wrangler secret put RESEND_API_KEY"
fi

# ── Deploy ────────────────────────────────────────────────────────────────────

echo ""
echo "🚀  Deploying CheckPulse Worker..."
$WRANGLER deploy
echo ""
echo "════════════════════════════════════════════════════════════"
echo "✅  CheckPulse is LIVE!"
echo ""
echo "📋  Add these as GitHub repository secrets for auto-deploy:"
echo "    CLOUDFLARE_API_TOKEN = $CLOUDFLARE_API_TOKEN"
echo "    CLOUDFLARE_ACCOUNT_ID = $CLOUDFLARE_ACCOUNT_ID"
echo ""
echo "    Go to: https://github.com/adadadada321321/checkpulse/settings/secrets/actions"
echo ""
echo "    After adding secrets, every push to main auto-deploys."
echo "════════════════════════════════════════════════════════════"
