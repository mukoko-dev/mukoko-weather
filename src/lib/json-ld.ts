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
