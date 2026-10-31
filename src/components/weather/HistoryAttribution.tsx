import type { HistorySourceCredit } from "@/lib/history-api";

/**
 * Credits for the climate archives that filled days on a history view (#268).
 *
 * Every archive provider asks to be credited wherever its data appears: NASA
 * POWER requests an acknowledgement of the LaRC POWER Project, and Open-Meteo
 * and ERA5 data is CC BY 4.0. The Worker returns one entry per provider present
 * in the answer (`sources` on `/v1/history`), so this renders exactly the
 * credits the visible data needs, and nothing when every day was recorded live.
 */
export function HistoryAttribution({
  sources,
}: {
  sources: HistorySourceCredit[];
}) {
  if (sources.length === 0) return null;
  return (
    <aside aria-label="Data sources" className="dove mt-1">
      <ul className="flex flex-col gap-1">
        {sources.map((s) => (
          <li key={s.id} data-source={s.id}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="sunbird"
            >
              {s.name}
            </a>
            : {s.attribution}.
            {s.licenceUrl ? (
              <>
                {" "}
                <a
                  href={s.licenceUrl}
                  target="_blank"
                  rel="noopener noreferrer license"
                  className="sunbird"
                >
                  {s.licence}
                </a>
              </>
            ) : (
              ` ${s.licence}`
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
