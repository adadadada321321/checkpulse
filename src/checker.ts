import type { CheckResult, CheckStep, ProductsResponse, Store } from "./types";

const STEP_TIMEOUT_MS = 10_000;

function normalizeUrl(raw: string): string {
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = STEP_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function diagnose(step: number, statusCode: number, finalUrl: string): string {
  if (step === 1) {
    if (statusCode === 401 || statusCode === 403) {
      return "Store products API unreachable — store may be offline or password-protected";
    }
    if (statusCode === 404) {
      return "Store products API unreachable — domain may be invalid or store is offline";
    }
    if (statusCode >= 500) {
      return "Store server error — Shopify platform may be experiencing an outage";
    }
    return `Products API returned unexpected status ${statusCode} — store may be misconfigured`;
  }

  if (step === 2) {
    if (statusCode === 422) {
      return "Cart creation failed — product may be out of stock or variant invalid";
    }
    if (statusCode >= 500) {
      return "Cart service error — Shopify platform issue";
    }
    if (statusCode === 401 || statusCode === 403) {
      return "Cart creation unauthorized — store may require login or is restricted";
    }
    return `Cart add.js returned unexpected status ${statusCode}`;
  }

  if (step === 3) {
    if (statusCode === 401 || statusCode === 403) {
      return "Checkout session unauthorized — Shopify Payments may be suspended";
    }
    if (finalUrl.includes("/password")) {
      return "Store is password-protected — checkout blocked";
    }
    if (statusCode >= 500) {
      return "Checkout server error — Shopify platform issue";
    }
    return `Checkout request returned unexpected status ${statusCode}`;
  }

  if (step === 4) {
    if (finalUrl.includes("/password")) {
      return "Store is password-protected — checkout blocked";
    }
    return "Checkout URL pattern not found — checkout flow may be customized or broken";
  }

  return "Unknown failure";
}

export async function checkStore(store: Store): Promise<CheckResult> {
  const base = normalizeUrl(store.domain);
  const steps: CheckStep[] = [];
  const overallStart = Date.now();

  // Step 1: GET /products.json — find first in-stock product variant
  let variantId: number | null = null;
  let productTitle = "";
  {
    const stepStart = Date.now();
    const stepNum = 1;
    const url = `${base}/products.json?limit=10`;
    let statusCode = 0;
    let passed = false;
    let error: string | undefined;

    try {
      const resp = await fetchWithTimeout(url, {
        headers: { Accept: "application/json" },
      });
      statusCode = resp.status;

      if (resp.ok) {
        const data = (await resp.json()) as ProductsResponse;
        const products = data.products ?? [];

        outer: for (const product of products) {
          for (const variant of product.variants ?? []) {
            if (variant.available) {
              variantId = variant.id;
              productTitle = product.title;
              passed = true;
              break outer;
            }
          }
        }

        if (!passed) {
          error = "No in-stock products found";
        }
      } else {
        error = `HTTP ${statusCode}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Fetch failed";
      statusCode = 0;
    }

    const duration = Date.now() - stepStart;
    steps.push({
      step: stepNum,
      name: "Fetch products.json",
      url,
      status_code: statusCode,
      duration_ms: duration,
      passed,
      error,
    });

    if (!passed) {
      return {
        store_id: store.id,
        passed: false,
        failure_step: stepNum,
        diagnosis: diagnose(stepNum, statusCode, url),
        steps,
        total_duration_ms: Date.now() - overallStart,
      };
    }
  }

  // Step 2: POST /cart/add.js — add product to cart
  let cartCookies = "";
  {
    const stepStart = Date.now();
    const stepNum = 2;
    const url = `${base}/cart/add.js`;
    let statusCode = 0;
    let passed = false;
    let error: string | undefined;

    try {
      const body = JSON.stringify({
        id: variantId,
        quantity: 1,
      });

      const resp = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        redirect: "follow",
      });
      statusCode = resp.status;

      // Capture any Set-Cookie headers for the checkout step
      const setCookie = resp.headers.get("set-cookie");
      if (setCookie) {
        cartCookies = setCookie;
      }

      if (resp.ok) {
        passed = true;
      } else {
        error = `HTTP ${statusCode}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Fetch failed";
      statusCode = 0;
    }

    const duration = Date.now() - stepStart;
    steps.push({
      step: stepNum,
      name: `Add to cart (variant ${variantId} — ${productTitle})`,
      url,
      status_code: statusCode,
      duration_ms: duration,
      passed,
      error,
    });

    if (!passed) {
      return {
        store_id: store.id,
        passed: false,
        failure_step: stepNum,
        diagnosis: diagnose(stepNum, statusCode, url),
        steps,
        total_duration_ms: Date.now() - overallStart,
      };
    }
  }

  // Step 3: GET /checkout — follow redirect chain
  let finalUrl = "";
  let checkoutStatusCode = 0;
  {
    const stepStart = Date.now();
    const stepNum = 3;
    const url = `${base}/checkout`;
    let passed = false;
    let error: string | undefined;

    try {
      const headers: Record<string, string> = {
        Accept: "text/html,application/xhtml+xml",
      };
      if (cartCookies) {
        headers["Cookie"] = cartCookies;
      }

      const resp = await fetchWithTimeout(url, {
        headers,
        redirect: "follow",
      });
      checkoutStatusCode = resp.status;
      finalUrl = resp.url;

      // We consider a 200 or 3xx-that-resolved-to-200 as step 3 passing
      if (resp.ok) {
        passed = true;
      } else {
        error = `HTTP ${checkoutStatusCode}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Fetch failed";
      checkoutStatusCode = 0;
      finalUrl = url;
    }

    const duration = Date.now() - stepStart;
    steps.push({
      step: stepNum,
      name: "Initiate checkout",
      url,
      status_code: checkoutStatusCode,
      duration_ms: duration,
      passed,
      error,
    });

    if (!passed) {
      return {
        store_id: store.id,
        passed: false,
        failure_step: stepNum,
        diagnosis: diagnose(stepNum, checkoutStatusCode, finalUrl),
        steps,
        total_duration_ms: Date.now() - overallStart,
      };
    }
  }

  // Step 4: Validate final URL contains /checkout/ path — confirms we landed on checkout
  {
    const stepNum = 4;
    const stepStart = Date.now();

    // Shopify checkout URLs follow the pattern:
    // https://{store}.myshopify.com/{locale}/checkouts/{token}
    // or https://checkout.shopify.com/...
    // or https://{custom_domain}/checkouts/{token}
    const isCheckoutUrl =
      finalUrl.includes("/checkouts/") ||
      finalUrl.includes("/checkout/") ||
      finalUrl.includes("checkout.shopify.com");

    const passed = isCheckoutUrl && !finalUrl.includes("/password");
    const duration = Date.now() - stepStart;

    steps.push({
      step: stepNum,
      name: "Verify checkout URL",
      url: finalUrl,
      status_code: checkoutStatusCode,
      duration_ms: duration,
      passed,
      error: passed ? undefined : `Final URL did not match checkout pattern: ${finalUrl}`,
    });

    if (!passed) {
      return {
        store_id: store.id,
        passed: false,
        failure_step: stepNum,
        diagnosis: diagnose(stepNum, checkoutStatusCode, finalUrl),
        steps,
        total_duration_ms: Date.now() - overallStart,
      };
    }
  }

  return {
    store_id: store.id,
    passed: true,
    failure_step: null,
    diagnosis: "All steps passed — checkout flow is healthy",
    steps,
    total_duration_ms: Date.now() - overallStart,
  };
}
