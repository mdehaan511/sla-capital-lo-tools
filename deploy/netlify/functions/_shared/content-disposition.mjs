/**
 * _shared/content-disposition.mjs — Deploy 237.139 (Mike: "we've been getting
 * a bunch of random errors in slack")
 *
 * THE BUG: HTTP header values are ByteStrings — every character must fit in a
 * byte (0–255). Document names carry real punctuation: a curly apostrophe
 * (U+2019, 8217) from anything typed in Word or on a Mac, an em dash, an
 * accented letter. Building
 *
 *     'Content-Disposition': 'inline; filename="' + name + '"'
 *
 * from such a name makes the Response constructor throw
 *
 *     Cannot convert argument to a ByteString because the character at
 *     index 38 has a value of 8217 which is greater than 255
 *
 * …which surfaced as a 500 on loan-review-doc-get every time a processor
 * opened a document whose name came from a borrower-typed entity name.
 * Stripping the character would fix the crash and mangle the filename, so
 * instead we send both forms RFC 6266 defines:
 *
 *   filename="…"            a plain-ASCII fallback for ancient clients
 *   filename*=UTF-8''…      percent-encoded UTF-8, which every current
 *                           browser prefers — the name arrives intact
 *
 * Use this for ANY filename that comes from stored data. A filename built
 * only from a regex-stripped ASCII slug can't hit the bug, but routing it
 * through here costs nothing and keeps the next edit safe.
 */

/**
 * A plain-ASCII version of a filename, keeping the extension and turning the
 * common typographic characters into their ASCII cousins rather than dropping
 * them (so "Owner's Statement — March.pdf" reads as "Owner's Statement - March.pdf"
 * instead of "Owners Statement  March.pdf").
 */
export function asciiFilename(name, fallback) {
  const raw = String(name == null ? '' : name).replace(/[\r\n\t]+/g, ' ').trim();
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(raw);
  const ext = m ? m[0] : '';
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  const ascii = stem
    .normalize('NFKD')                          // é → e + combining accent
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // curly single quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '')  // curly double quotes (a " would end the quoted-string)
    .replace(/[\u2010-\u2015\u2212]/g, '-')      // en/em dash, minus
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E]/g, '')                // anything still outside printable ASCII
    .replace(/["\\]/g, '')                       // would break out of the quoted-string
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (ascii || String(fallback || 'document')) + ext;
}

/**
 * A complete Content-Disposition value.
 *   contentDisposition('inline', "Owner’s Rent Roll.pdf")
 *   → inline; filename="Owner's Rent Roll.pdf"; filename*=UTF-8''Owner%E2%80%99s%20Rent%20Roll.pdf
 *
 * type: 'inline' | 'attachment'
 */
export function contentDisposition(type, name, fallback) {
  const disp = type === 'attachment' ? 'attachment' : 'inline';
  const raw = String(name == null ? '' : name).replace(/[\r\n\t]+/g, ' ').trim();
  const ascii = asciiFilename(raw, fallback);
  let out = disp + '; filename="' + ascii + '"';
  // Only worth sending when it says something the fallback doesn't.
  if (raw && raw !== ascii) {
    // RFC 5987 attr-char: alphanumerics and !#$&+-.^_`|~ . encodeURIComponent
    // leaves !'()*~ alone, so finish the job by hand.
    const enc = encodeURIComponent(raw).replace(/['()*!~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    out += "; filename*=UTF-8''" + enc;
  }
  return out;
}
