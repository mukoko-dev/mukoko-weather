"use client";

import {
  MONTH_ABBR,
  STAGE_CLASSES,
  STAGE_LABELS,
  stageForMonth,
  type CropCalendar,
  type CropStage,
} from "@/lib/agriculture";

/**
 * Planting / harvest calendar for the user's crops, from the stored location
 * profile. Months run Jan–Dec; the current month is marked. Renders an
 * explanatory note when the profile has no calendar for this place yet.
 */

interface Props {
  calendar: readonly CropCalendar[];
  /** 1-based current month in the location's time zone. */
  currentMonth: number;
}

const LEGEND: CropStage[] = ["nursery", "plant", "grow", "harvest"];

export function CropCalendarTable({ calendar, currentMonth }: Props) {
  return (
    <section aria-labelledby="agri-calendar" className="acacia space-y-3">
      <h2 id="agri-calendar" className="giraffe">
        Planting and harvest calendar
      </h2>
      {calendar.length === 0 ? (
        <p className="gazelle">
          A crop calendar for this place is not available yet. Local planting
          follows the onset of the rains; check with your extension officer.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto" data-no-swipe>
            <table className="w-full min-w-[36rem] border-separate border-spacing-1 text-sm">
              <caption className="sr-only">
                Typical crop stages by month
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="dove text-left font-medium">
                    Crop
                  </th>
                  {MONTH_ABBR.map((m, i) => (
                    <th
                      key={m}
                      scope="col"
                      aria-current={i + 1 === currentMonth ? "date" : undefined}
                      className={`dove font-medium ${i + 1 === currentMonth ? "text-text-primary underline underline-offset-4" : ""}`}
                    >
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {calendar.map((crop) => (
                  <tr key={crop.id}>
                    <th
                      scope="row"
                      className="text-left font-medium text-text-primary"
                    >
                      {crop.label}
                      {crop.phase && (
                        <span className="dove block font-normal">
                          Now: {crop.phase}
                        </span>
                      )}
                    </th>
                    {MONTH_ABBR.map((m, i) => {
                      const stage = stageForMonth(crop, i + 1);
                      return (
                        <td
                          key={m}
                          className={`h-8 rounded-[var(--radius-badge)] text-center ${stage ? STAGE_CLASSES[stage] : "bg-surface-dim"}`}
                        >
                          <span className="sr-only">
                            {m}: {stage ? STAGE_LABELS[stage] : "none"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-wrap gap-3" aria-label="Legend">
            {LEGEND.map((s) => (
              <li key={s} className="dove flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`h-3 w-5 rounded-[var(--radius-badge)] ${STAGE_CLASSES[s]}`}
                />
                {STAGE_LABELS[s]}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
