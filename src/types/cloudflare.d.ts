/**
 * Cloudflare Workers KV Namespace type declaration.
 * When deployed to Cloudflare, the actual runtime provides this interface.
 * This declaration allows TypeScript to compile without the full @cloudflare/workers-types package.
 */
interface KVNamespace {
  get(key: string, options?: { type?: "text" }): Promise<string | null>;
  get(key: string, options: { type: "json" }): Promise<unknown>;
  get(key: string, options: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  get(key: string, options: { type: "stream" }): Promise<ReadableStream | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}
