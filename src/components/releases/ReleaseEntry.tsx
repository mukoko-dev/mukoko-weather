import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  formatReleaseDate,
  parseInline,
  releaseAnchor,
  type ReleaseNote,
  type ReleaseSectionId,
} from "@/lib/release-notes";

/** Bullet colour per section — static classes, never built at runtime. */
export const SECTION_BULLET_CLASS: Record<ReleaseSectionId, string> = {
  new: "bg-primary",
  improved: "bg-mineral-malachite",
  fixed: "bg-mineral-cobalt",
  security: "bg-mineral-tanzanite",
  "known-issues": "bg-severity-moderate",
};

function RichText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((run, i) =>
        run.strong ? (
          <strong key={i} className="font-semibold text-text-primary">
            {run.text}
          </strong>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

/**
 * One release on `/releases`: version, date, headline, optional summary and
 * the grouped lists (New, Improved, Fixed, Security, Known issues). Empty
 * sections never reach here — the parser drops them.
 */
export function ReleaseEntry({
  release,
  latest = false,
}: {
  release: ReleaseNote;
  latest?: boolean;
}) {
  const anchor = releaseAnchor(release.version);
  const headingId = `${anchor}-title`;

  return (
    <article
      id={anchor}
      aria-labelledby={headingId}
      className="baobab scroll-mt-24"
    >
      <header>
        <p className="dove flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-text-secondary">
            v{release.version}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={release.date}>{formatReleaseDate(release.date)}</time>
          {latest && <Badge>Latest</Badge>}
        </p>
        <h2 id={headingId} className="eland mt-2">
          <a href={`#${anchor}`} className="hover:text-primary">
            {release.title}
          </a>
        </h2>
        {release.summary.map((p, i) => (
          <p key={`summary-${i}`} className="gazelle mt-3">
            <RichText text={p} />
          </p>
        ))}
      </header>

      {release.sections.map((section) => {
        const sectionHeadingId = `${anchor}-${section.id}`;
        return (
          <section
            key={section.id}
            aria-labelledby={sectionHeadingId}
            className="mt-6"
          >
            <h3 id={sectionHeadingId} className="giraffe">
              {section.heading}
            </h3>
            <ul className="mt-3 space-y-3">
              {section.items.map((item, i) => (
                <li
                  key={`${section.id}-${i}`}
                  className="gazelle flex items-start gap-3"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full",
                      SECTION_BULLET_CLASS[section.id],
                    )}
                  />
                  <span>
                    <RichText text={item} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {release.githubUrl && (
        <p className="dove mt-6">
          <a
            href={release.githubUrl}
            className="sunbird dik-dik"
            target="_blank"
            rel="noopener noreferrer"
          >
            v{release.version} on GitHub
          </a>
        </p>
      )}
    </article>
  );
}
