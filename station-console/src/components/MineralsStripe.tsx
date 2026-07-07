/**
 * Seven-mineral brand ribbon — ALWAYS vertical, never horizontal: a fixed
 * 4px strip down the left viewport edge, matching the main weather app's
 * MineralsStripe. The gradient (Mzizi registry order: tanzanite, cobalt,
 * gold, malachite, copper, sodalite, terracotta) lives in globals.css.
 */
export function MineralsStripe() {
  return (
    <div className="minerals-stripe" role="presentation" aria-hidden="true" />
  );
}
