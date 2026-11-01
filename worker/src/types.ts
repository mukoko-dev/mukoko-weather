/** Cloudflare Worker environment bindings */
export interface Env {
  // KV Namespaces
  WEATHER_CACHE: KVNamespace;
  WIDGET_CONFIGS: KVNamespace;

  // Environment variables
  ENVIRONMENT: string;
  CORS_ORIGINS: string;
  NEXT_APP_URL: string;
}
