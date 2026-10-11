"use client";

import { useAppStore } from "@/lib/store";
import type { CropAdvice } from "@/lib/agriculture";

/**
 * Deterministic, crop-aware notes for the user's farming activities. With no
 * farming activity selected, offers the My Weather activity picker instead.
 */

interface Props {
  advice: readonly CropAdvice[];
}

export function AgricultureCropAdvice({ advice }: Props) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  return (
    <section aria-labelledby="agri-crops" className="acacia space-y-3">
      <h2 id="agri-crops" className="giraffe">
        For your crops
      </h2>
      {advice.length === 0 ? (
        <p className="gazelle">
          Tell us what you farm to see advice for your crops and livestock.{" "}
          <button
            type="button"
            onClick={() => openMyWeather("activities")}
            className="sunbird dik-dik"
          >
            Pick your crops
          </button>
        </p>
      ) : (
        <ul className="space-y-4">
          {advice.map((c) => (
            <li key={c.id}>
              <h3 className="text-base font-semibold text-mineral-malachite">
                {c.label}
              </h3>
              <ul className="gazelle mt-1 list-disc space-y-1 pl-5">
                {c.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
