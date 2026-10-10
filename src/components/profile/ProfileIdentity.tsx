"use client";

/**
 * The signed-in user's name, picture and the control to change the name —
 * the Mukoko ecosystem profile identity header (mukoko-news
 * `src/components/profile/profile-identity.tsx`; mukoko-events renders the
 * same centred avatar + serif name + email via NyuchiProfileBlock).
 *
 * Values come from `identity.persons` (see `src/lib/profile.ts`), not the
 * session claims — that record is what every Mukoko app renders. Saving
 * writes that record, then mirrors the name to WorkOS. The picture is
 * display-only: changing it needs an upload target (separate work).
 */

import { useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { updateProfileAction } from "@/app/profile/actions";
import {
  initialsFor,
  isValidImageUrl,
  MAX_PROFILE_NAME_LENGTH,
} from "@/lib/user-display";

export interface ProfileIdentityProps {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  pictureUrl?: string | null;
}

export function ProfileIdentity({
  firstName,
  lastName,
  email,
  pictureUrl,
}: ProfileIdentityProps) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(firstName ?? "");
  const [last, setLast] = useState(lastName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The session cookie keeps the old claims until AuthKit refreshes it, so
  // show what was just saved rather than letting the heading snap back.
  const [displayed, setDisplayed] = useState({
    first: firstName ?? "",
    last: lastName ?? "",
  });

  const [imageFailed, setImageFailed] = useState(false);
  const showPicture = !imageFailed && isValidImageUrl(pictureUrl);
  const displayName =
    [displayed.first, displayed.last].filter(Boolean).join(" ") || email || "";
  const initials = initialsFor({
    firstName: displayed.first,
    lastName: displayed.last,
    email,
  });

  async function save() {
    setSaving(true);
    setError(null);
    const result = await updateProfileAction({
      firstName: first,
      lastName: last,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDisplayed({ first: first.trim(), last: last.trim() });
    setEditing(false);
    setSaved(true);
  }

  function cancel() {
    setFirst(displayed.first);
    setLast(displayed.last);
    setError(null);
    setEditing(false);
  }

  return (
    <section aria-labelledby="profile-name" className="mb-10 text-center">
      <div
        className="mx-auto mb-5 flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-container-tanzanite"
        aria-hidden="true"
      >
        {showPicture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pictureUrl as string}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className="font-display text-2xl font-semibold text-on-container-tanzanite">
            {initials}
          </span>
        )}
      </div>

      {editing ? (
        <div className="mx-auto max-w-sm text-left">
          <h1 id="profile-name" className="sr-only">
            Edit your name
          </h1>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="dove">First name</span>
              <input
                value={first}
                onChange={(e) => setFirst(e.target.value)}
                maxLength={MAX_PROFILE_NAME_LENGTH}
                autoComplete="given-name"
                className="crane mt-1 min-h-[var(--touch-target-min)]"
              />
            </label>
            <label className="block">
              <span className="dove">Last name</span>
              <input
                value={last}
                onChange={(e) => setLast(e.target.value)}
                maxLength={MAX_PROFILE_NAME_LENGTH}
                autoComplete="family-name"
                className="crane mt-1 min-h-[var(--touch-target-min)]"
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="mb-3 text-sm text-severity-severe">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="kudu-sm inline-flex items-center gap-2 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="h-4 w-4" aria-hidden="true" />
              )}
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="impala-sm inline-flex items-center gap-2"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Cancel
            </button>
          </div>
          <p className="dove mt-3">
            Your name is shared across your Mukoko account, so this updates it
            everywhere.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-1 flex items-center justify-center gap-2">
            <h1
              id="profile-name"
              className="font-display text-2xl font-bold text-text-primary"
            >
              {displayName}
            </h1>
            <button
              type="button"
              onClick={() => {
                setSaved(false);
                setEditing(true);
              }}
              aria-label="Edit your profile"
              className="inline-flex h-[var(--touch-target-min)] w-[var(--touch-target-min)] items-center justify-center rounded-full transition-colors hover:bg-surface-dim"
            >
              <Pencil
                className="h-4 w-4 text-text-secondary"
                aria-hidden="true"
              />
            </button>
          </div>
          {email && <p className="text-text-secondary">{email}</p>}
          {saved && (
            <p role="status" className="mt-2 text-xs text-severity-low">
              Profile updated across your Mukoko account.
            </p>
          )}
        </>
      )}
    </section>
  );
}
