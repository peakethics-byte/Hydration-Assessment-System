// Shared display formats (US English), used by pages, emails and PDFs.
// Plain dates ("2026-09-15") are read at noon UTC so they never shift a day by time zone.

type DateLike = string | Date;
const asText = (v: DateLike) => (typeof v === 'string' ? v : v.toISOString());
const asDate = (v: DateLike) => (typeof v === 'string' ? new Date(v.length === 10 ? `${v}T12:00:00Z` : v) : v);

/** "September 15, 2026" */
export const longDate = (v: DateLike | null | undefined, empty = '-') =>
  v ? asDate(asText(v).slice(0, 10)).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' }) : empty;

/** "Sep 15, 2026" */
export const mediumDate = (v: DateLike | null | undefined, empty = '-') => (v ? asDate(v).toLocaleDateString('en-US', { dateStyle: 'medium' }) : empty);

/** "Sep 15" */
export const shortDate = (v: DateLike | null | undefined, empty = '') => (v ? asDate(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : empty);

/** "9/15/2026, 10:30:00 AM" */
export const dateTime = (v: DateLike | null | undefined, empty = '-') => (v ? new Date(v).toLocaleString('en-US') : empty);

/** "3 of 12 (25.0%)", or the withheld label when a figure is suppressed. */
export const ofTotal = (m: { n: number | null; d: number | null; pct: string | null; suppressed: boolean }, withheld = 'Withheld (privacy)') =>
  m.suppressed ? withheld : `${m.n} of ${m.d} (${m.pct ?? '0.0'}%)`;
