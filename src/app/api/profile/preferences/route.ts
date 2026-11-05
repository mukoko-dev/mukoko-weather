/**
 * The signed-in person's activities and saved places
 * (mukoko-dev/mukoko-weather#484): they follow the PERSON, not the device.
 *
 *   GET /api/profile/preferences → the person's items (tombstones included)
 *   PUT /api/profile/preferences → merge a subset, item by item; answers the
 *                                  merged whole, so a client reconciles from
 *                                  one response
 *
 * The JSON is the contract of nyuchi/nyuchi-api#483 (`person-preferences.ts`
 * says where it differs and why), so this route can become a thin forward to
 * that API with no client change. PUT is the contract's PATCH: it merges, it
 * never replaces a list.
 *
 * The person is the verified AuthKit session, never an id in the request.
 * A session cookie with no resolved user is AuthKit failing to say who (a
 * WorkOS outage, a refresh token used twice): that is `503`, which the client
 * retries, and only a request with no cookie at all is `401`, which makes the
 * client stop for the page (the rule of `/api/couch/session`).
 *
 * Storage is the one module `person-preferences-store.ts`; this file names no
 * database, collection or field. It is OFF until nyuchi has applied the
 * validator change (`PERSON_PREFERENCES_READY`), and answers
 * `503 preferences_unavailable` without touching storage. Saved places have
 * their own switch (`PERSON_SAVED_PLACES_READY`): while it is off a `PUT` still
 * applies its activities and reports `notApplied: ["savedPlaces"]`. Errors are
 * RFC 9457 problems whose text is fixed: nothing from the request is echoed,
 * and nothing a person chose is ever logged.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  currentSession,
  hasSessionCookie,
  problemResponse,
  readBoundedText,
  sameOriginJsonRefusal,
} from "@/lib/api-route-guards";
import { logWarn } from "@/lib/observability";
import {
  MAX_BODY_BYTES,
  parsePatch,
  toDocument,
  type Problem,
} from "@/lib/person-preferences";
import {
  PERSON_PREFERENCES_READY,
  PERSON_SAVED_PLACES_READY,
} from "@/lib/person-preferences-switches";
import { personPreferencesStore } from "@/lib/person-preferences-store";
import { checkUserRateLimit } from "@/lib/user-rate-limit";

export const dynamic = "force-dynamic";

/**
 * Per person: [max requests, window seconds] (the limits #483 asks for). Not
 * exported: a Next.js route file may export only its handlers and config.
 */
const PREFERENCES_LIMITS = {
  read: [60, 60],
  write: [30, 60],
} as const;

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Fixed sentences, one per code. Never built from the request. */
const DETAILS: Record<string, string> = {
  unauthorized: "Sign in to use your saved preferences.",
  session_unavailable:
    "Your sign-in could not be checked just now. Try again shortly.",
  forbidden_origin: "Cross-site requests are not allowed.",
  unsupported_media_type: "Send the request as application/json.",
  rate_limited: "Too many requests. Try again shortly.",
  preferences_unavailable:
    "Saving your preferences to your account is not available yet. They still work on this device.",
  store_unavailable: "Your preferences are temporarily unavailable.",
  person_not_found: "There is no account record to save to yet.",
  payload_too_large: "The request body is too large.",
  invalid_json: "The request body is not valid JSON.",
  invalid_body: "The request was not accepted.",
  unknown_field: "The request has a field that is not allowed.",
  schema_version_not_supported: "That schemaVersion is not supported.",
  settings_not_supported: "Settings are not stored here yet.",
  invalid_activity: "An activity is not in the expected form.",
  activity_not_allowed: "An activity is not one this app offers.",
  invalid_saved_place: "A saved place is not in the expected form.",
  duplicate_item: "An item appears twice in the request.",
  updated_at_in_future: "An updatedAt is too far ahead of the server's clock.",
  too_many_activities: "That would be more activities than a profile holds.",
  too_many_places: "That would be more saved places than a profile holds.",
};

function problem(
  status: number,
  code: string,
  retryAfterSeconds?: number,
): Response {
  return problemResponse(status, code, DETAILS[code] ?? DETAILS.invalid_body, {
    retryAfterSeconds,
    cacheControl: PRIVATE_NO_STORE["Cache-Control"],
  });
}

const fromProblem = (p: Problem) => problem(p.status, p.code);

/** The gates both verbs share: the signed-in person, the switch, the limit. */
async function gate(
  req: Request,
  action: keyof typeof PREFERENCES_LIMITS,
): Promise<{ userId: string } | Response> {
  const { userId } = await currentSession();
  if (!userId) {
    return hasSessionCookie(req)
      ? problem(503, "session_unavailable", 30)
      : problem(401, "unauthorized");
  }
  // Off: answer before anything is read or counted, so no storage is touched.
  if (!PERSON_PREFERENCES_READY) return problem(503, "preferences_unavailable");
  const [max, window] = PREFERENCES_LIMITS[action];
  const limit = await checkUserRateLimit(
    `person-prefs-${action}`,
    userId,
    max,
    window,
  );
  if (!limit.allowed) {
    return problem(429, "rate_limited", limit.retryAfterSeconds);
  }
  return { userId };
}

function storeFailure(action: string, error: unknown): Response {
  // The error's class only: driver errors can echo a connection string.
  logWarn({
    source: "unhandled",
    message: "Person preferences store failed",
    meta: {
      action,
      errorName: error instanceof Error ? error.name : typeof error,
    },
  });
  return problem(503, "store_unavailable", 30);
}

export async function GET(req: NextRequest): Promise<Response> {
  const gated = await gate(req, "read");
  if (gated instanceof Response) return gated;
  try {
    const stored = await personPreferencesStore.read(gated.userId);
    if (!stored) return problem(404, "person_not_found");
    return NextResponse.json(
      toDocument(
        stored.activities,
        PERSON_SAVED_PLACES_READY ? stored.savedPlaces : [],
      ),
      { headers: PRIVATE_NO_STORE },
    );
  } catch (error) {
    return storeFailure("read", error);
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const refusal = sameOriginJsonRefusal(req);
  if (refusal === "unsupported_media_type") {
    return problem(415, refusal);
  }
  if (refusal) return problem(403, refusal);

  const gated = await gate(req, "write");
  if (gated instanceof Response) return gated;

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return problem(413, "payload_too_large");
  }
  const text = await readBoundedText(req, MAX_BODY_BYTES);
  if (text === null) return problem(413, "payload_too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return problem(400, "invalid_json");
  }

  const parsed = parsePatch(body, Date.now(), {
    savedPlaces: PERSON_SAVED_PLACES_READY,
  });
  if (!parsed.ok) return fromProblem(parsed.problem);

  try {
    const result = await personPreferencesStore.merge(
      gated.userId,
      parsed.patch,
      new Date(),
    );
    if (result.kind === "no_person") return problem(404, "person_not_found");
    if (result.kind === "refused") return fromProblem(result.problem);
    return NextResponse.json(
      {
        ...toDocument(
          result.stored.activities,
          PERSON_SAVED_PLACES_READY ? result.stored.savedPlaces : [],
        ),
        // What the request carried that was left out on purpose.
        ...(parsed.ignored.length > 0 ? { notApplied: parsed.ignored } : {}),
      },
      { headers: PRIVATE_NO_STORE },
    );
  } catch (error) {
    return storeFailure("write", error);
  }
}
