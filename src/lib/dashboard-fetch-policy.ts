/**
 * When the location dashboard fires its client-side fetches.
 *
 * The server render already carries the full forecast. Anything fetched
 * after mount competes with hydration and the first paint, so a fetch for
 * content below the fold waits until that content is near the viewport.
 */

/**
 * How close (px) the end of the main column must be before the comparison
 * series + minutely nowcast are fetched. Generous, so the data is in by the
 * time the reader arrives.
 */
export const MODEL_EXTRAS_ROOT_MARGIN = "1200px";

/**
 * Whether to fetch /api/py/weather?models=… now.
 *
 * - A picked forecast model (anything but the default blend) becomes the
 *   baseline for the whole page, so it is fetched at once.
 * - With the default blend the response only feeds the nowcast and the
 *   model comparison at the end of the main column: wait until it is near.
 */
export function shouldFetchModelExtras(
  model: string,
  endOfColumnNear: boolean,
): boolean {
  if (model && model !== "best_match") return true;
  return endOfColumnNear;
}
