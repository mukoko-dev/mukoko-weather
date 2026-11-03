import { safeJsonLd } from "@/lib/json-ld";

/**
 * Renders schema.org JSON-LD in a `<script type="application/ld+json">`.
 * Always serialises through `safeJsonLd`, so a place name can't break out of
 * the script element. Server component (no client code).
 */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJsonLd(data) }}
    />
  );
}
