// Team / institution aggregation, the institution dashboard, formal quarterly and annual reports,
// reporting periods and exports (contract Week 6; Document #5).
//
// Access model: coaches and institution leaders cannot read individual records (row-level security).
// The reporting service therefore checks the signed-in user's reporting scope first, then aggregates on
// the server, applies small-cell suppression, and returns only population-level figures.
export * from './scope';
export * from './periods';
export * from './data';
export * from './formal';
export * from './export';
export { longDate as fmtDate } from '../../domain/format';
