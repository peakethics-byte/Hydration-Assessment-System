// Record statuses in one place (Document #7 lifecycle). The database CHECK constraints in
// db/migrations/003_assessment.sql and 009_reporting.sql hold the same lists; change both together.

export type InstanceStatus =
  | 'Not Started' | 'In Progress' | 'Submitted' | 'Validation Check' | 'Complete / Scored'
  | 'Reviewed' | 'Released' | 'Correction Required' | 'Revalidated' | 'Expired';

/** Valid, scored results: counted in history, change analysis and reports. */
export const SCORED: readonly string[] = ['Complete / Scored', 'Reviewed', 'Released', 'Revalidated'] satisfies InstanceStatus[];

/** Results a WeCanH2O reviewer can mark Reviewed (new or rescored after a correction). */
export const REVIEWABLE: readonly string[] = ['Complete / Scored', 'Revalidated'] satisfies InstanceStatus[];

/** Results whose answers an administrator may correct (always with a reason). */
export const CORRECTABLE: readonly string[] = SCORED;

/** Statuses offered in the Athletes search filter. */
export const SEARCHABLE: readonly string[] = ['In Progress', 'Complete / Scored', 'Reviewed', 'Released', 'Revalidated', 'Correction Required'] satisfies InstanceStatus[];

export const OUTCOME_UNKNOWN = 'Reassessment Not Completed / Outcome Unknown';

export type ReportStatus = 'Draft' | 'Under Review' | 'Revision Required' | 'Approved' | 'Released' | 'Superseded';
