/**
 * Guard for the owner rule: "AI is served to the backend only", and "the
 * backend uses the Workers AI binding; no frontend ever passes directly to
 * Cloudflare AI".
 *
 * Only the Rust weather Workers (workers/ai, through the native env.AI
 * binding and the shamwari gateway) run models. The Python backend (api/py)
 * reaches them over HTTPS through mukoko-weather-internal with the service
 * key and holds no Cloudflare AI token. Browser code, Next.js server/client
 * components, NEXT_PUBLIC_* vars, the edge worker/ and the embed go through
 * our backend routes (/api/ai/* → /api/py/ai/*, /api/py/chat,
 * /api/py/explore/search). This test fails if src/, worker/ or api/py
 * references the gateway host, a Workers AI call, an AI SDK or a Cloudflare
 * AI token env name — and, when a production build exists, if the client
 * bundle does.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");

const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: "AI Gateway host", pattern: /gateway\.ai\.cloudflare\.com/ },
  { label: "Workers AI REST path", pattern: /\/ai\/(run|v1)\b/ },
  { label: "Workers AI binding call", pattern: /\bAI\.run\(/ },
  { label: "Cloudflare AI token env", pattern: /\bCF_AI_API_TOKEN\b/ },
  { label: "AI gateway token env", pattern: /\bAI_GATEWAY_TOKEN\b/ },
  { label: "Workers AI token env", pattern: /\bCF_WORKERS_AI_TOKEN\b/ },
  { label: "AI gateway URL env", pattern: /\bAI_GATEWAY_URL\b/ },
  {
    label: "Workers AI REST host",
    pattern: /api\.cloudflare\.com\/client\/v4\/accounts\/[^\s"'`]*\/ai\b/,
  },
  {
    label: "public AI env",
    pattern: /NEXT_PUBLIC_[A-Z_]*(AI_GATEWAY|WORKERS_AI|CF_AI_API)/,
  },
  { label: "Anthropic SDK", pattern: /@anthropic-ai\/sdk/ },
  { label: "OpenAI SDK", pattern: /from\s+["']openai["']/ },
];

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

function violations(
  files: string[],
  skip: (f: string) => boolean = () => false,
) {
  const found: string[] = [];
  for (const file of files) {
    if (skip(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(text)) found.push(`${relative(ROOT, file)}: ${label}`);
    }
  }
  return found;
}

const THIS_FILE = __filename;

describe("AI is served by the backend only, through the weather Worker", () => {
  it("src/ never calls Cloudflare AI directly or names an AI token", () => {
    const files = walk(join(ROOT, "src"), SOURCE_EXT);
    expect(files.length).toBeGreaterThan(0);
    expect(violations(files, (f) => f === THIS_FILE)).toEqual([]);
  });

  it("the edge worker/ never calls Cloudflare AI directly or names an AI token", () => {
    const files = [
      ...walk(join(ROOT, "worker", "src"), SOURCE_EXT),
      join(ROOT, "worker", "wrangler.toml"),
      join(ROOT, "worker", "package.json"),
    ].filter(existsSync);
    expect(violations(files)).toEqual([]);
  });

  it("the Python backend api/py reaches AI only through the weather Worker", () => {
    const files = walk(join(ROOT, "api", "py"), /\.py$/);
    expect(files.length).toBeGreaterThan(0);
    expect(violations(files)).toEqual([]);
  });

  it("the client bundle (when built) never references the gateway or AI tokens", () => {
    const files = walk(join(ROOT, ".next", "static"), /\.js$/);
    // No build in a plain `npm test` run — nothing to scan then.
    expect(violations(files)).toEqual([]);
  });
});
