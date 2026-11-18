// Small text helpers shared by services.

// Control characters become spaces, runs of whitespace collapse, ends are trimmed.
export const cleanLine = (value) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// cleanLine, and anything shaped like an HTML tag is removed. For text from the
// AI, which is untrusted: it is stored and shown as plain text (and escaped on
// every page), so markup has no business in it. A lone "<" as in "x < y" stays.
export const plainText = (value) =>
  cleanLine(String(value ?? '').replace(/<\/?[a-z!][^>]*>/gi, ' '));
