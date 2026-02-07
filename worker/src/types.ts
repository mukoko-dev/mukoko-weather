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

  // Secrets
  ANTHROPIC_API_KEY?: string;
}
