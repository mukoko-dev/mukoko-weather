import {
  readStorageJSON,
  removeStorage,
  writeStorageJSON,
} from "./safe-storage";

const RETRY_STORAGE_KEY = "mukoko-error-retries";
const MAX_RETRIES = 3;

export function getRetryCount(): number {
  if (typeof window === "undefined") return 0;
  const data = readStorageJSON<{ url?: string; count?: number } | null>(
    RETRY_STORAGE_KEY,
    null,
    "session",
  );
  if (!data) return 0;
  if (data.url === window.location.href) return data.count ?? 0;
  return 0;
}

export function setRetryCount(count: number): void {
  if (typeof window === "undefined") return;
  writeStorageJSON(
    RETRY_STORAGE_KEY,
    { url: window.location.href, count },
    "session",
  );
}

export function clearRetryCount(): void {
  removeStorage(RETRY_STORAGE_KEY, "session");
}

export { MAX_RETRIES };
