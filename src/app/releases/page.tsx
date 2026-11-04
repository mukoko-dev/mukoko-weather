import type { Metadata } from "next";
import { PageShell } from "@/components/layout/PageShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { trail } from "@/components/layout/Breadcrumb";
import { ReleaseEntry } from "@/components/releases/ReleaseEntry";
import { loadReleaseNotes } from "@/lib/release-notes-source";
import { GITHUB_RELEASES_URL, releasesJsonLd } from "@/lib/release-notes";
import { JsonLd } from "@/components/layout/JsonLd";
import { SITE_URL } from "@/lib/site";

// Built once from the curated files in releases/ — no request-time work and
// no GitHub calls. A new release note ships with the deploy that adds it.
export const dynamic = "force-static";

const DESCRIPTION =
  "What's new in mukoko weather: new features, improvements and fixes in each release, in plain language.";

export const metadata: Metadata = {
  title: "Release notes",
  description: DESCRIPTION,
  alternates: {
    canonical: `${SITE_URL}/releases`,
    types: {
      "application/atom+xml": [
        {
          url: `${SITE_URL}/releases/feed.xml`,
          title: "mukoko weather release notes",
        },
      ],
    },
  },
  openGraph: {
    title: "Release notes | mukoko weather",
    description: DESCRIPTION,
    url: `${SITE_URL}/releases`,
  },
};

export default function ReleasesPage() {
  const releases = loadReleaseNotes();

  return (
    <>
      {releasesJsonLd(releases, SITE_URL).map((schema) => (
        <JsonLd key={schema["@type"]} data={schema} />
      ))}
      <PageShell breadcrumb={trail({ label: "Release notes" })}>
        <PageHeader
          title="Release notes"
          intro="What changed in each release of mukoko weather, newest first."
        >
          <p className="dove mt-2">
            <a href="/releases/feed.xml" className="sunbird dik-dik">
              Follow updates with the feed
            </a>
            {" · "}
            <a
              href={GITHUB_RELEASES_URL}
              className="sunbird dik-dik"
              target="_blank"
              rel="noopener noreferrer"
            >
              Full technical history on GitHub
            </a>
          </p>
        </PageHeader>

        <ol aria-label="Releases" className="herd mt-8">
          {releases.map((release, i) => (
            <li key={release.version}>
              <ReleaseEntry release={release} latest={i === 0} />
            </li>
          ))}
        </ol>
      </PageShell>
    </>
  );
}
