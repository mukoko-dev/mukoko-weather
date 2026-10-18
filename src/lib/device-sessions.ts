/**
 * "Where I am signed in", from the person's own WorkOS sessions.
 *
 * This is the real, working source for the Devices section of /profile while
 * the platform has no person-owned device record yet (see
 * mukoko-dev/mukoko-weather#320). A WorkOS session is exactly one signed-in
 * browser or installed app, and ending it is the only revocation the platform
 * can honour today.
 *
 * Rules, all enforced here and pinned by tests:
 * - Only the caller's own sessions: the user id comes from the AuthKit
 *   session, never from the request.
 * - Only active, unexpired sessions are listed.
 * - Nothing identifying leaves this module: no IP address, no raw user agent
 *   string, no session id except the opaque handle the page needs to end it.
 * - A session is ended only after it is found in that user's own active list,
 *   so a guessed or stale id can never reach WorkOS.
 *
 * Server-only.
 */

import {
  deviceLabel,
  parseUserAgent,
  type DeviceBrowser,
  type DeviceFormFactor,
  type DeviceOs,
} from "./device-info";

/** The parts of a WorkOS session this module reads. */
export interface WorkosSession {
  id: string;
  userId: string;
  userAgent: string | null;
  status: "active" | "expired" | "revoked";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  // ipAddress exists on the real object and is deliberately not read.
}

/** The two WorkOS calls used, so tests (and a Worker) can inject their own. */
export interface SessionsApi {
  list(userId: string): Promise<WorkosSession[]>;
  revoke(sessionId: string): Promise<void>;
}

/** What the browser is allowed to see about one signed-in device. */
export interface SignedInDevice {
  /** WorkOS session id: the handle for "sign this device out". */
  id: string;
  label: string;
  os: DeviceOs;
  browser: DeviceBrowser;
  formFactor: DeviceFormFactor;
  /** The session making this request. */
  current: boolean;
  /** ISO 8601. */
  signedInAt: string;
  /** ISO 8601: the session's last refresh. */
  lastActiveAt: string;
}

export const MAX_DEVICES = 50;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Active, unexpired sessions as devices: this one first, then newest. */
export function toSignedInDevices(
  sessions: readonly WorkosSession[],
  currentSessionId: string | undefined,
  now: number = Date.now(),
): SignedInDevice[] {
  return sessions
    .filter(
      (s) =>
        s.status === "active" &&
        isSessionId(s.id) &&
        (ms(s.expiresAt) === 0 || ms(s.expiresAt) > now),
    )
    .map((s): SignedInDevice => {
      const parsed = parseUserAgent(s.userAgent);
      return {
        id: s.id,
        label: deviceLabel(parsed),
        os: parsed.os,
        browser: parsed.browser,
        formFactor: parsed.formFactor,
        current: s.id === currentSessionId,
        signedInAt: s.createdAt,
        lastActiveAt: s.updatedAt,
      };
    })
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return ms(b.lastActiveAt) - ms(a.lastActiveAt);
    })
    .slice(0, MAX_DEVICES);
}

export async function listSignedInDevices(
  api: SessionsApi,
  userId: string,
  currentSessionId: string | undefined,
  now?: number,
): Promise<SignedInDevice[]> {
  return toSignedInDevices(await api.list(userId), currentSessionId, now);
}

export type SignOutResult = "ended" | "not_found";

/**
 * End one of the caller's sessions. Looks the id up in the caller's own
 * active list first; an id that is not there is `not_found` and never
 * reaches WorkOS.
 */
export async function signOutDevice(
  api: SessionsApi,
  userId: string,
  sessionId: string,
  now?: number,
): Promise<SignOutResult> {
  if (!isSessionId(sessionId)) return "not_found";
  const owned = toSignedInDevices(await api.list(userId), undefined, now);
  if (!owned.some((d) => d.id === sessionId)) return "not_found";
  await api.revoke(sessionId);
  return "ended";
}

/** The real WorkOS-backed API. Imported lazily so tests never load AuthKit. */
export async function workosSessionsApi(): Promise<SessionsApi> {
  const { getWorkOS } = await import("@workos-inc/authkit-nextjs");
  const um = getWorkOS().userManagement;
  return {
    async list(userId) {
      const page = await um.listSessions(userId, { limit: MAX_DEVICES });
      return page.data.map((s) => ({
        id: s.id,
        userId: s.userId,
        userAgent: s.userAgent,
        status: s.status,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    },
    async revoke(sessionId) {
      await um.revokeSession({ sessionId });
    },
  };
}
