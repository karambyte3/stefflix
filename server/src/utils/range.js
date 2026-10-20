/**
 * Parses an HTTP Range header (RFC 7233) for a resource of `size` bytes.
 *
 * Returns one of:
 *   { type: 'none' }                      no header, or a header we must ignore -> 200 with the full body
 *   { type: 'unsatisfiable' }             -> 416
 *   { type: 'range', start, end }         inclusive byte offsets -> 206
 *
 * Only the first range of a multi-range request is honoured. Browsers never send
 * multi-range requests for media, so multipart/byteranges responses aren't worth it.
 */
export function parseRange(header, size) {
  if (!header || typeof header !== 'string') return { type: 'none' };

  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!match) return { type: 'none' };

  const first = match[1].split(',')[0].trim();
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(first);
  if (!parts) return { type: 'none' };

  const [, startStr, endStr] = parts;
  if (startStr === '' && endStr === '') return { type: 'none' };

  // Suffix range: "bytes=-500" means the last 500 bytes.
  if (startStr === '') {
    const suffixLength = Number(endStr);
    if (suffixLength === 0 || size === 0) return { type: 'unsatisfiable' };
    return { type: 'range', start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startStr);
  let end = endStr === '' ? size - 1 : Number(endStr);

  // "bytes=500-100" is syntactically invalid -> the header must be ignored.
  if (endStr !== '' && end < start) return { type: 'none' };
  if (start >= size) return { type: 'unsatisfiable' };
  if (end >= size) end = size - 1;

  return { type: 'range', start, end };
}
