// Population-level aggregation for dashboards and formal reports (Document #5).
// Pure functions over stored results, so every figure is reproducible (REP-001) and keeps its
// numerator and denominator (REP-020). Privacy suppression is applied here, before anything is shown
// or exported (PRV-201..203).
import Decimal from 'decimal.js';
import type { ScoringContent } from '../methodology/types';
import { bandFor, roundDisplay } from './scoring';

export interface CohortFinding {
  ruleId: string;
  title: string;
  category: string | null;
  sourceClass: string | null;
  priorityClass: number | null;
  isSafety: boolean;
  isStrength: boolean;
}

/** One valid, scored assessment with its stored results. */
export interface CohortRow {
  participantId: string;
  instanceId: string;
  teamId: string | null; // team at the assessment date (time-aware affiliation, REP-005)
  isBaseline: boolean;
  submittedAt: string;
  asmVersion: string;
  hgiInternal: string | null;
  categories: Record<string, { percent: string | null; status: string }>;
  findings: CohortFinding[];
}

/** A reported figure. `n`/`d` stay available for review even when the percentage is rounded (REP-020). */
export interface Metric {
  n: number | null;
  d: number | null;
  pct: string | null;
  suppressed: boolean;
}

export const pct = (n: number, d: number): string | null =>
  d > 0 ? roundDisplay(new Decimal(n).div(d).mul(100)).toFixed(1) : null;

export const metric = (n: number, d: number): Metric => ({ n, d, pct: pct(n, d), suppressed: false });
export const hidden = (): Metric => ({ n: null, d: null, pct: null, suppressed: true });

/** One assessment per athlete per cohort: the latest valid one (no double counting, REP-006). */
export function latestPerAthlete(rows: CohortRow[]): CohortRow[] {
  const byP = new Map<string, CohortRow>();
  for (const r of rows) {
    const cur = byP.get(r.participantId);
    if (!cur || r.submittedAt > cur.submittedAt) byP.set(r.participantId, r);
  }
  return [...byP.values()];
}

export function mean(values: Decimal[]): Decimal | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a.plus(b), new Decimal(0)).div(values.length);
}

export function median(values: Decimal[]): Decimal | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a.comparedTo(b));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : s[m - 1].plus(s[m]).div(2);
}

const show = (v: Decimal | null) => (v == null ? null : roundDisplay(v).toFixed(1));

export interface PatternCount {
  ruleId: string;
  title: string;
  category: string | null;
  sourceClass: string | null;
  priorityClass: number | null;
  isSafety: boolean;
  athletes: Metric;
}

export interface GroupSummary {
  assessed: number;
  suppressed: boolean; // true when the group is below the threshold: no health figures are shown
  hgiMean: string | null;
  hgiMedian: string | null;
  hgiN: number;
  bands: { band: string; athletes: Metric }[];
  categories: { code: string; name: string; meanPct: string | null; n: number; contextual: boolean }[];
  gaps: PatternCount[];
  strengths: PatternCount[];
  institutional: PatternCount[];
  /** Athletes with at least one safety/support finding. Never names or symptom detail (PRV-204). */
  safety: Metric & { present: boolean };
}

/** Institutional / access / environmental patterns, with Category 2 always visible (Section 4 of the report). */
export const isInstitutional = (f: CohortFinding) =>
  f.category === 'C2' || (f.sourceClass ?? '').startsWith('Institutional') || (f.sourceClass ?? '').startsWith('Shared');

function countPatterns(rows: CohortRow[], pick: (f: CohortFinding) => boolean, d: number): PatternCount[] {
  const map = new Map<string, PatternCount & { who: Set<string> }>();
  for (const r of rows) {
    for (const f of r.findings) {
      if (!pick(f)) continue;
      const cur = map.get(f.ruleId) ?? { ruleId: f.ruleId, title: f.title, category: f.category, sourceClass: f.sourceClass,
        priorityClass: f.priorityClass, isSafety: f.isSafety, athletes: metric(0, d), who: new Set<string>() };
      cur.who.add(r.participantId);
      map.set(f.ruleId, cur);
    }
  }
  return [...map.values()]
    .map(({ who, ...p }) => ({ ...p, athletes: metric(who.size, d) }))
    .sort((a, b) => (a.priorityClass ?? 9) - (b.priorityClass ?? 9) || (b.athletes.n ?? 0) - (a.athletes.n ?? 0) || a.ruleId.localeCompare(b.ruleId));
}

/**
 * Summarises one group (institution, team or filtered cohort). Below the suppression threshold only the
 * participation count is kept; every health figure is withheld (PRV-202).
 */
export function summarize(input: CohortRow[], scoring: ScoringContent, threshold: number): GroupSummary {
  const rows = latestPerAthlete(input);
  const d = rows.length;
  const empty: GroupSummary = {
    assessed: d, suppressed: true, hgiMean: null, hgiMedian: null, hgiN: 0, bands: [],
    categories: [], gaps: [], strengths: [], institutional: [], safety: { ...hidden(), present: false },
  };
  if (d === 0) return { ...empty, suppressed: false, safety: { ...metric(0, 0), present: false } };
  if (d < threshold) return empty;

  const hgis = rows.filter((r) => r.hgiInternal != null).map((r) => new Decimal(r.hgiInternal!));
  const bandCounts = new Map<string, number>();
  for (const h of hgis) {
    const b = bandFor(roundDisplay(h, scoring.rounding.places), scoring);
    bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
  }
  const categories = scoring.categories.map((c) => {
    const contextual = !scoring.hgiCategories.includes(c.code);
    const vals = rows.map((r) => r.categories[c.code]).filter((x) => x && x.status === 'Scored' && x.percent != null).map((x) => new Decimal(x!.percent!));
    return { code: c.code, name: c.name, meanPct: contextual ? null : show(mean(vals)), n: vals.length, contextual };
  });

  const safetyN = rows.filter((r) => r.findings.some((f) => f.isSafety)).length;
  // A count of 1..threshold-1 could point to individuals, so only its presence is reported.
  // It is never hidden altogether: a safety/support priority must stay visible (REP-031).
  const safety = safetyN > 0 && safetyN < threshold ? { ...hidden(), present: true } : { ...metric(safetyN, d), present: safetyN > 0 };

  return {
    assessed: d,
    suppressed: false,
    hgiMean: show(mean(hgis)),
    hgiMedian: show(median(hgis)),
    hgiN: hgis.length,
    bands: scoring.bands.map((b) => ({ band: b.label, athletes: metric(bandCounts.get(b.label) ?? 0, hgis.length) })),
    categories,
    gaps: countPatterns(rows, (f) => !f.isStrength, d),
    strengths: countPatterns(rows, (f) => f.isStrength, d),
    institutional: countPatterns(rows, (f) => !f.isStrength && isInstitutional(f), d),
    safety,
  };
}

/**
 * Team comparison with complementary suppression: when exactly one team is below the threshold, the
 * next-smallest team is withheld as well, so the hidden team cannot be worked out from the institution
 * total (PRV-203).
 */
export function suppressTeams<T extends { assessed: number; suppressed: boolean }>(teams: T[], threshold: number, withhold: (t: T) => T): T[] {
  const out = teams.map((t) => (t.assessed > 0 && t.assessed < threshold ? withhold(t) : t));
  const hiddenCount = out.filter((t) => t.suppressed && t.assessed > 0).length;
  if (hiddenCount === 1) {
    const visible = out.map((t, i) => ({ t, i })).filter(({ t }) => !t.suppressed && t.assessed > 0).sort((a, b) => a.t.assessed - b.t.assessed);
    if (visible.length) out[visible[0].i] = withhold(out[visible[0].i]);
  }
  return out;
}

/** True when showing `part` next to the whole would let a viewer work out a group below the threshold. */
export function complementTooSmall(whole: number, part: number, threshold: number) {
  const rest = whole - part;
  return rest > 0 && rest < threshold;
}

// ---- Matched cohort (REP-019, REP-025) ----
export interface MatchedRow {
  participantId: string;
  hgiBaseline: string;
  hgiCurrent: string;
  hgiChange: string;
  findingStates: { ruleId: string; title: string; state: string; isSafety: boolean; isContextual: boolean; sourceClass: string | null }[];
}

export interface MatchedSummary {
  n: number;
  suppressed: boolean;
  baselineMean: string | null;
  currentMean: string | null;
  meanChange: string | null;
  higher: Metric; // HGI went up
  same: Metric;
  lower: Metric;
  states: { state: string; athletes: Metric }[];
}

export const CHANGE_STATES = ['Improved', 'Resolved', 'Persistent', 'Worsened', 'New'] as const;

export function summarizeMatched(rows: MatchedRow[], threshold: number): MatchedSummary {
  const n = rows.length;
  if (n === 0 || n < threshold) {
    return { n, suppressed: n > 0, baselineMean: null, currentMean: null, meanChange: null, higher: hidden(), same: hidden(), lower: hidden(), states: [] };
  }
  const ch = rows.map((r) => new Decimal(r.hgiChange));
  return {
    n,
    suppressed: false,
    baselineMean: show(mean(rows.map((r) => new Decimal(r.hgiBaseline)))),
    currentMean: show(mean(rows.map((r) => new Decimal(r.hgiCurrent)))),
    meanChange: show(mean(ch)),
    higher: metric(ch.filter((c) => c.gt(0)).length, n),
    same: metric(ch.filter((c) => c.eq(0)).length, n),
    lower: metric(ch.filter((c) => c.lt(0)).length, n),
    states: CHANGE_STATES.map((s) => ({
      state: s,
      athletes: metric(rows.filter((r) => r.findingStates.some((f) => f.state === s && !f.isContextual)).length, n),
    })),
  };
}

/**
 * Observational wording only: describes what was seen and never says WeCanH2O or an intervention caused
 * it (REP-022, TST-REP-015).
 */
export function describeChange(m: MatchedSummary): string {
  if (m.n === 0) return 'No matched baseline-and-reassessment pairs are available for this period yet.';
  if (m.suppressed) return 'The matched cohort is smaller than the privacy threshold, so change figures are withheld.';
  const dir = Number(m.meanChange) > 0 ? 'higher' : Number(m.meanChange) < 0 ? 'lower' : 'unchanged';
  return `Among the ${m.n} athletes in the Matched Cohort, the average HGI was ${m.baselineMean} at baseline and ${m.currentMean} at reassessment `
    + `(${dir === 'unchanged' ? 'no change' : `${m.meanChange} points, ${dir}`}). This describes an observed change only; it does not by itself explain the change.`;
}
