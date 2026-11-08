// Small text helpers shared by services.

// Control characters become spaces, runs of whitespace collapse, ends are trimmed.
export const cleanLine = (value) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
