/**
 * Decorative seven-mineral stripe — the Mukoko brand ribbon (Mzizi registry
 * `brand_minerals` order: cobalt, tanzanite, malachite, gold, terracotta,
 * sodalite, copper). Colours come from the L1 tokens in globals.css.
 */
const MINERALS = [
  "bg-cobalt",
  "bg-tanzanite",
  "bg-malachite",
  "bg-gold",
  "bg-terracotta",
  "bg-sodalite",
  "bg-copper",
] as const;

export function MineralsStripe() {
  return (
    <div
      className="flex h-1 w-full overflow-hidden rounded-full"
      aria-hidden="true"
    >
      {MINERALS.map((cls) => (
        <span key={cls} className={`${cls} flex-1`} />
      ))}
    </div>
  );
}
