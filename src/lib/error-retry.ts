const RETRY_STORAGE_KEY = "mukoko-error-retries";
const MAX_RETRIES = 3;

export function getRetryCount(): number {
  try {
    const stored = sessionStorage.getItem(RETRY_STORAGE_KEY);
    if (!stored) return 0;
    const data = JSON.parse(stored);
    if (data.url === window.location.href) return data.count;
    return 0;
  } catch {
    return 0;
  }
}

export function setRetryCount(count: number): void {
  try {
    sessionStorage.setItem(
      RETRY_STORAGE_KEY,
      JSON.stringify({ url: window.location.href, count }),
    );
  } catch {
    // sessionStorage unavailable
  }
}

export function clearRetryCount(): void {
  try {
    sessionStorage.removeItem(RETRY_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable
  }
}

export { MAX_RETRIES };
