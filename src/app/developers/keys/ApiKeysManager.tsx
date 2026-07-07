"use client";

/**
 * Client surface for developer API key management.
 *
 * Lists the signed-in user's keys (masked), creates new keys, and revokes
 * them. On create, the FULL key is shown exactly once with a copy button and a
 * "you won't see it again" warning — the server never returns it a second time.
 *
 * All colours/styles come from brand tokens + fauna classes (globals.css);
 * no hardcoded hex or inline styles.
 */

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, TrashIcon } from "@/lib/weather-icons";

interface ApiKey {
  id: string;
  label: string;
  maskedKey: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const MAX_KEYS = 10;

function CopyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-ZW", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function ApiKeysManager() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [entityRequired, setEntityRequired] = useState(false);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load keys (${res.status})`);
      const data = (await res.json()) as {
        keys: ApiKey[];
        entityRequired?: boolean;
      };
      setKeys(data.keys ?? []);
      setEntityRequired(Boolean(data.entityRequired));
    } catch {
      setError("Could not load your API keys. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const atCapacity = keys.length >= MAX_KEYS;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || creating || atCapacity || entityRequired) return;
    setCreating(true);
    setError(null);
    setNewKey(null);
    setCopied(false);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: trimmed }),
      });
      const data = (await res.json()) as {
        key?: ApiKey;
        fullKey?: string;
        message?: string;
        error?: string;
      };
      // No eligible entity membership — surface the guidance state.
      if (res.status === 403 || data.error === "entity_required") {
        setEntityRequired(true);
        throw new Error(data.message ?? "An entity is required to create a key.");
      }
      if (!res.ok || !data.key || !data.fullKey) {
        throw new Error(data.message ?? "Could not create the key.");
      }
      setNewKey(data.fullKey);
      setKeys((prev) => [data.key as ApiKey, ...prev]);
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the key.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (revokingId) return;
    setRevokingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not revoke the key.");
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch {
      setError("Could not revoke the key. Please try again.");
    } finally {
      setRevokingId(null);
    }
  }

  async function handleCopy() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy failed — select and copy the key manually.");
    }
  }

  return (
    <section
      className="mt-8 space-y-6"
      aria-labelledby="api-keys-heading"
    >
      <h2 id="api-keys-heading" className="sr-only">
        Your API keys
      </h2>

      {/* One-time full-key reveal */}
      {newKey && (
        <div
          className="baobab space-y-3"
          role="status"
          aria-live="polite"
        >
          <p className="giraffe">Your new API key</p>
          <p className="dove">
            Copy it now — for your security, you won&apos;t be able to see this
            key again.
          </p>
          <div className="tortoise flex items-center gap-3">
            <code className="flex-1 break-all font-mono text-sm text-text-primary">
              {newKey}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="impala-primary shrink-0"
              aria-label="Copy API key to clipboard"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </div>
      )}

      {/* Entity-required guidance — shown when the developer has no eligible
          entity membership. Keys are owned by the developer's entity. */}
      {entityRequired && (
        <div className="baobab space-y-2" role="status">
          <p className="giraffe">A registered entity is required</p>
          <p className="gazelle">
            API keys are owned by an entity. To create one, you must be a
            founder, admin, manager, or representative of a registered entity.
          </p>
          <a
            href="mailto:support@mukoko.com?subject=Register%20an%20entity%20for%20API%20keys"
            className="impala-primary w-fit"
          >
            Register or claim an entity
          </a>
        </div>
      )}

      {/* Create form */}
      <form onSubmit={handleCreate} className="acacia space-y-3">
        <label
          htmlFor="key-label"
          className="giraffe block"
        >
          Create a new key
        </label>
        <p className="dove">
          Give the key a label so you can recognise it later (e.g. &ldquo;My
          weather site&rdquo;).
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="key-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            placeholder="Key label"
            disabled={creating || atCapacity || entityRequired}
            className="flex-1 rounded-[var(--radius-input)] border border-border bg-surface-base px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
            aria-describedby="key-capacity"
          />
          <button
            type="submit"
            disabled={!label.trim() || creating || atCapacity || entityRequired}
            className="kudu-sm shrink-0"
          >
            <PlusIcon size={16} />
            <span>{creating ? "Creating…" : "Create new key"}</span>
          </button>
        </div>
        <p id="key-capacity" className="dove">
          {keys.length}/{MAX_KEYS} keys used
          {atCapacity ? " — revoke one to create another." : "."}
        </p>
      </form>

      {error && (
        <div className="alert-banner" role="alert">
          <p className="text-sm text-text-primary">{error}</p>
        </div>
      )}

      {/* Key list */}
      {loading ? (
        <div className="chameleon h-24" role="status" aria-label="Loading" />
      ) : keys.length === 0 ? (
        <p className="gazelle">You don&apos;t have any API keys yet.</p>
      ) : (
        <ul className="space-y-3" aria-label="Existing API keys">
          {keys.map((k) => (
            <li
              key={k.id}
              className="acacia flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-text-primary">
                  {k.label}
                </p>
                <p className="dove font-mono">{k.maskedKey}</p>
                <p className="dove">Created {formatDate(k.createdAt)}</p>
              </div>
              <button
                type="button"
                onClick={() => handleRevoke(k.id)}
                disabled={revokingId === k.id}
                className="impala shrink-0"
                aria-label={`Revoke API key ${k.label}`}
              >
                <TrashIcon size={16} />
                <span>{revokingId === k.id ? "Revoking…" : "Revoke"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
