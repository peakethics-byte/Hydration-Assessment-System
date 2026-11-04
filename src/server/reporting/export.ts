import type { Db } from '../db';
import { audit } from '../audit';
import { PermissionError } from '../roster';
import type { Metric } from '../../engine/aggregate';
import { reportScope } from './scope';
import type { ReportData } from './data';

// ---------------------------------------------------------------- exports
/** Logs an authorized export with user, scope, time, format and context (AUD-203, TST-AUD-001). */
export async function recordExport(db: Db, userId: string, input: { tenantId: string; format: 'PDF' | 'CSV'; context: Record<string, unknown> }) {
  return db.system(async (tx) => {
    const scope = await reportScope(tx, userId, input.tenantId);
    if (!scope.canExport) {
      await audit(tx, { tenantId: input.tenantId, userId, action: 'denied', recordType: 'export', reason: 'export right required', newValue: input.context });
      throw new PermissionError('Export is a separate right. Ask WeCanH2O to allow export for your account.');
    }
    await audit(tx, { tenantId: input.tenantId, userId, action: 'export', recordType: 'report_export',
      newValue: { format: input.format, scope: scope.teamIds ? { teams: scope.teamIds } : 'institution', ...input.context } });
    return scope;
  });
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const mCells = (m: Metric) => (m.suppressed ? ['suppressed', '', '', ''] : [m.n, m.d, m.pct ?? '', '']);

/** Structured export of the aggregate figures, with the same suppression as the screen (PRV-203, REP-037). */
export function reportCsv(d: ReportData): string {
  const rows: unknown[][] = [
    ['institution', d.tenant.name], ['period', `${d.period.type} ${d.period.start} to ${d.period.end}`],
    ['program_year', `${d.period.programYearStart} to ${d.period.programYearEnd}`], ['generated_at', d.generatedAt],
    ['suppression_threshold', d.threshold], ['filters', JSON.stringify(d.filters)], [],
    ['section', 'measure', 'numerator', 'denominator', 'percent', 'value'],
    ['participation', 'eligible', '', '', '', d.participation.eligible],
    ['participation', 'assessed', '', '', '', d.participation.assessed],
    ['participation', 'baseline', '', '', '', d.participation.baseline],
    ['participation', 'reassessed', '', '', '', d.participation.reassessed],
    ['participation', 'completion', ...mCells(d.participation.completion)],
  ];
  const s = d.summary;
  if (s.suppressed) rows.push(['hgi', 'all health figures', 'suppressed', '', '', '']);
  else {
    rows.push(['hgi', 'mean', '', '', '', s.hgiMean], ['hgi', 'median', '', '', '', s.hgiMedian]);
    for (const b of s.bands) rows.push(['hgi_band', b.band, ...mCells(b.athletes)]);
    for (const c of s.categories) rows.push(['category', `${c.code} ${c.name}`, '', c.n, '', c.contextual ? 'contextual - not part of HGI' : c.meanPct]);
    for (const g of s.gaps) rows.push(['gap', g.title, ...mCells(g.athletes)]);
    for (const g of s.strengths) rows.push(['strength', g.title, ...mCells(g.athletes)]);
    for (const g of s.institutional) rows.push(['institutional', g.title, ...mCells(g.athletes)]);
    rows.push(['safety_support', 'athletes with an indicator', ...(s.safety.suppressed ? [s.safety.present ? 'present' : 'suppressed', '', '', ''] : mCells(s.safety))]);
  }
  const m = d.matched;
  rows.push(['matched_cohort', 'athletes', '', '', '', m.suppressed ? 'suppressed' : m.n]);
  if (!m.suppressed && m.n) {
    rows.push(['matched_cohort', 'mean HGI baseline', '', '', '', m.baselineMean], ['matched_cohort', 'mean HGI current', '', '', '', m.currentMean],
      ['matched_cohort', 'mean change', '', '', '', m.meanChange], ['matched_cohort', 'HGI higher', ...mCells(m.higher)],
      ['matched_cohort', 'HGI same', ...mCells(m.same)], ['matched_cohort', 'HGI lower', ...mCells(m.lower)]);
    for (const st of m.states) rows.push(['matched_cohort_gaps', st.state, ...mCells(st.athletes)]);
  }
  rows.push(['reassessment', 'windows due', '', '', '', d.reassessment.due], ['reassessment', 'completed', ...mCells(d.reassessment.completed)],
    ['reassessment', 'Outcome Unknown', ...mCells(d.reassessment.outcomeUnknown)], ['reassessment', 'still open', ...mCells(d.reassessment.stillOpen)],
    ['interventions', 'results released', '', '', '', d.interventions.resultsReleased], ['interventions', 'action items delivered', '', '', '', d.interventions.itemsDelivered],
    ['interventions', 'action items completed', ...mCells(d.interventions.itemsCompleted)]);
  for (const t of d.teams) rows.push(['team', t.name, '', '', '', t.suppressed ? 'suppressed' : `assessed ${t.assessed}; mean HGI ${t.hgiMean ?? '-'}`]);
  for (const t of d.trend) rows.push(['trend', `${t.period} ${t.start} to ${t.end}`, '', '', '', t.suppressed ? 'suppressed' : `assessed ${t.assessed}; mean HGI ${t.hgiMean ?? '-'}`]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
