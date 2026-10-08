/** Cloudflare Worker environment bindings */
export interface Env {
  // KV Namespaces
  AI_SUMMARIES: KVNamespace;
  WEATHER_CACHE: KVNamespace;
  WIDGET_CONFIGS: KVNamespace;

  // Environment variables
  ENVIRONMENT: string;
  CORS_ORIGINS: string;
  NEXT_APP_URL: string;

  // Secrets — AI is served by the Python backend only; the worker holds no AI token.
  MUKOKO_INTERNAL_SECRET?: string;
}
