import { checkStore } from "./checker";
import type { Env, Store } from "./types";

// ── Cron: runs every hour ────────────────────────────────
async function runChecks(env: Env): Promise<void> {
  if (!env.DB) return; // lite mode — no persistent monitoring

  const { results: stores } = await env.DB.prepare(
    "SELECT * FROM stores WHERE active = 1"
  ).all<Store>();

  for (const store of stores) {
    const result = await checkStore(store);

    await env.DB.prepare(
      `INSERT INTO check_results
         (store_id, passed, failure_step, diagnosis, steps_json, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        store.id,
        result.passed ? 1 : 0,
        result.failure_step ?? null,
        result.diagnosis,
        JSON.stringify(result.steps),
        result.total_duration_ms
      )
      .run();

    if (!result.passed) {
      const incident = await env.DB.prepare(
        "SELECT id FROM incidents WHERE store_id = ? AND resolved_at IS NULL LIMIT 1"
      )
        .bind(store.id)
        .first<{ id: number }>();

      if (!incident) {
        const ins = await env.DB.prepare(
          "INSERT INTO incidents (store_id) VALUES (?)"
        )
          .bind(store.id)
          .run();

        await sendAlert(env, store, result.diagnosis, result.failure_step ?? 0);

        await env.DB.prepare("UPDATE incidents SET alert_sent = 1 WHERE id = ?")
          .bind(ins.meta.last_row_id)
          .run();
      }
    } else {
      await env.DB.prepare(
        `UPDATE incidents SET resolved_at = datetime('now')
         WHERE store_id = ? AND resolved_at IS NULL`
      )
        .bind(store.id)
        .run();
    }
  }
}

async function sendAlert(
  env: Env,
  store: Store,
  diagnosis: string,
  failureStep: number
): Promise<void> {
  if (!env.RESEND_API_KEY) return;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "CheckPulse <alerts@checkpulse.io>",
      to: [store.alert_email],
      subject: `🚨 Checkout down: ${store.domain}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;padding:24px">
          <h2 style="color:#ef4444;margin:0 0 16px">Your checkout is broken</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#888">Store</td><td>${store.domain}</td></tr>
            <tr><td style="padding:8px 0;color:#888">Failed at step</td><td>${failureStep} / 4</td></tr>
            <tr><td style="padding:8px 0;color:#888">Diagnosis</td><td>${diagnosis}</td></tr>
          </table>
          <p style="margin-top:20px;color:#888;font-size:14px">
            CheckPulse will keep monitoring and send a recovery notice when your checkout is healthy again.
          </p>
        </div>
      `,
    }),
  });
}

// ── HTTP API ─────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/health") return json({ ok: true });

  // POST /check — stateless on-demand checkout check (lite mode, no DB needed)
  if (path === "/check" && method === "POST") {
    const body = (await request.json()) as { domain?: string; email?: string };
    if (!body.domain) return json({ error: "domain is required" }, 400);

    const domain = body.domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const store: Store = {
      id: "ondemand",
      domain,
      alert_email: body.email?.trim() ?? "",
      plan: "trial",
      active: 1,
    };

    const result = await checkStore(store);

    if (!result.passed && body.email && env.RESEND_API_KEY) {
      await sendAlert(env, store, result.diagnosis, result.failure_step ?? 0);
    }

    return json({ ...result, store_id: undefined, domain });
  }

  // POST /stores — register store + immediate check
  if (path === "/stores" && method === "POST") {
    if (!env.DB) return json({ error: "Persistent monitoring requires full setup. Use POST /check for on-demand checks." }, 503);
    const body = (await request.json()) as {
      domain?: string;
      email?: string;
      plan?: string;
    };
    if (!body.domain || !body.email)
      return json({ error: "domain and email are required" }, 400);

    const id = crypto.randomUUID();
    const domain = body.domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/$/, "");

    try {
      await env.DB.prepare(
        "INSERT INTO stores (id, domain, alert_email, plan) VALUES (?, ?, ?, ?)"
      )
        .bind(id, domain, body.email.trim(), body.plan ?? "solo")
        .run();
    } catch {
      return json({ error: "Store already registered with this domain" }, 409);
    }

    const store: Store = {
      id,
      domain,
      alert_email: body.email.trim(),
      plan: body.plan ?? "solo",
      active: 1,
    };
    const result = await checkStore(store);

    return json({ id, domain, initial_check: result }, 201);
  }

  // GET /stores
  if (path === "/stores" && method === "GET") {
    if (!env.DB) return json({ error: "Persistent monitoring requires full setup." }, 503);
    const { results } = await env.DB.prepare(
      "SELECT id, domain, alert_email, plan, active, created_at FROM stores ORDER BY created_at DESC"
    ).all<Store>();
    return json(results);
  }

  if (!env.DB) return json({ error: "Not found" }, 404);

  // GET /stores/:id/results
  const resultsMatch = path.match(/^\/stores\/([^/]+)\/results$/);
  if (resultsMatch && method === "GET") {
    const storeId = resultsMatch[1];
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "48"), 200);
    const { results } = await env.DB.prepare(
      `SELECT checked_at, passed, failure_step, diagnosis, duration_ms
       FROM check_results WHERE store_id = ?
       ORDER BY checked_at DESC LIMIT ?`
    )
      .bind(storeId, limit)
      .all();
    return json(results);
  }

  // GET /stores/:id/incidents
  const incidentMatch = path.match(/^\/stores\/([^/]+)\/incidents$/);
  if (incidentMatch && method === "GET") {
    const storeId = incidentMatch[1];
    const { results } = await env.DB.prepare(
      `SELECT id, started_at, resolved_at, alert_sent
       FROM incidents WHERE store_id = ?
       ORDER BY started_at DESC LIMIT 20`
    )
      .bind(storeId)
      .all();
    return json(results);
  }

  // POST /stores/:id/check — manual trigger
  const checkMatch = path.match(/^\/stores\/([^/]+)\/check$/);
  if (checkMatch && method === "POST") {
    const storeId = checkMatch[1];
    const store = await env.DB.prepare("SELECT * FROM stores WHERE id = ?")
      .bind(storeId)
      .first<Store>();
    if (!store) return json({ error: "Store not found" }, 404);

    const result = await checkStore(store);
    await env.DB.prepare(
      `INSERT INTO check_results
         (store_id, passed, failure_step, diagnosis, steps_json, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        store.id,
        result.passed ? 1 : 0,
        result.failure_step ?? null,
        result.diagnosis,
        JSON.stringify(result.steps),
        result.total_duration_ms
      )
      .run();

    return json(result);
  }

  // DELETE /stores/:id
  const deleteMatch = path.match(/^\/stores\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    await env.DB.prepare("UPDATE stores SET active = 0 WHERE id = ?")
      .bind(deleteMatch[1])
      .run();
    return json({ deleted: true });
  }

  // POST /webhooks/stripe
  if (path === "/webhooks/stripe" && method === "POST") {
    // Signature verification stubbed — add when STRIPE_WEBHOOK_SECRET is set
    return json({ received: true });
  }

  return json({ error: "Not found" }, 404);
}

// ── Exports ──────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (e) {
      console.error("Worker error:", e);
      return json({ error: "Internal server error" }, 500);
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    try {
      await runChecks(env);
    } catch (e) {
      console.error("Scheduled check error:", e);
    }
  },
};
