export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  RESEND_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

export interface CheckStep {
  step: number;
  name: string;
  url: string;
  status_code: number;
  duration_ms: number;
  passed: boolean;
  error?: string;
}

export interface CheckResult {
  store_id: string;
  passed: boolean;
  failure_step: number | null;
  diagnosis: string;
  steps: CheckStep[];
  total_duration_ms: number;
}

export interface Store {
  id: string;
  domain: string;
  alert_email: string;
  plan: string;
  active: number;
}

export interface ProductVariant {
  id: number;
  available: boolean;
  title: string;
}

export interface Product {
  id: number;
  title: string;
  variants: ProductVariant[];
}

export interface ProductsResponse {
  products: Product[];
}
