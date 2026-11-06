// ?page= as a positive whole number; anything else is page 1.
export function parsePage(value) {
  const requested = Number.parseInt(String(value ?? '1'), 10);
  return Number.isFinite(requested) && requested > 0 ? requested : 1;
}

export const pageCount = (total, pageSize) => Math.max(1, Math.ceil(total / pageSize));
