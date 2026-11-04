import { SITE_URL } from "@/lib/site";

/**
 * Safe serialization for JSON-LD injected into a
 * `<script type="application/ld+json">` tag via `dangerouslySetInnerHTML`.
 *
 * Location names, provinces and country names in mukoko weather are
 * Nominatim-derived and therefore attacker-influenceable. A raw `JSON.stringify`
 * leaves `<`, `>` and `&` intact, so a value containing `</script>` would break
 * out of the script element and execute — a stored XSS. Escaping those characters
 * to their `\uXXXX` forms keeps the JSON byte-for-byte semantically identical
 * (JSON parsers decode the escapes) while making script-tag breakout impossible.
 *
 * U+2028 / U+2029 are also escaped: they are valid inside JSON strings but are
 * line terminators in HTML/JS and can corrupt the surrounding document.
 */
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** One crumb after the root: `path` is relative to SITE_URL (omit for a crumb with no page). */
export interface BreadcrumbCrumb {
  name: string;
  path?: string;
}

export interface BreadcrumbOptions {
  /** Name of the root crumb (linked to SITE_URL). Defaults to the app name. */
  root?: string;
  /** Optional schema.org `@id`, used by the site-level breadcrumb. */
  id?: string;
}

/**
 * schema.org `BreadcrumbList`: the root crumb (SITE_URL) followed by `trail`,
 * positions 1..n. Pass the result to `<JsonLd data={…} />`.
 */
export function breadcrumbJsonLd(
  trail: readonly BreadcrumbCrumb[],
  { root = "mukoko weather", id }: BreadcrumbOptions = {},
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    ...(id ? { "@id": id } : {}),
    itemListElement: [
      { "@type": "ListItem", position: 1, name: root, item: SITE_URL },
      ...trail.map((crumb, i) => ({
        "@type": "ListItem",
        position: i + 2,
        name: crumb.name,
        ...(crumb.path !== undefined
          ? { item: `${SITE_URL}${crumb.path}` }
          : {}),
      })),
    ],
  };
}
