import { NextRequest } from "next/server";
import { logWarn } from "@/lib/observability";
import { sanitizeUrl } from "@/lib/location-privacy";

/**
 * CSP violation collector (report-only rollout, B05). Accepts the legacy
 * `application/csp-report` shape and the Reporting API array, keeps only
 * directive + blocked host/path + sanitised page path, logs one structured
 * line each, and always answers 204. Never stores anything.
 */
const MAX_BODY = 8192;

function origin(u: unknown): string {
  if (typeof u !== "string") return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u.slice(0, 20); // inline, eval, data, blob
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`.slice(0, 200);
  } catch {
    return "";
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return new Response(null, { status: 204 });
    const parsed: unknown = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items.slice(0, 5)) {
      const r = (item as Record<string, unknown>) ?? {};
      const body = (r["csp-report"] ?? r["body"] ?? r) as Record<
        string,
        unknown
      >;
      logWarn({
        source: "client-render",
        message: "csp-report-only violation",
        meta: {
          directive: String(
            body["effective-directive"] ??
              body["effectiveDirective"] ??
              body["violated-directive"] ??
              "",
          ).slice(0, 60),
          blocked: origin(body["blocked-uri"] ?? body["blockedURL"]),
          page: sanitizeUrl(
            String(body["document-uri"] ?? body["documentURL"] ?? ""),
          ),
        },
      });
    }
  } catch {
    /* malformed report: ignore */
  }
  return new Response(null, { status: 204 });
}
