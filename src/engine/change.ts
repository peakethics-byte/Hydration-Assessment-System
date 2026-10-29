// Longitudinal change analysis (Document #4; Milestone 3 Section 5). Pure and deterministic.
// Compares a baseline and a current assessment that were scored with stored rule versions.
import Decimal from 'decimal.js';
import type { AssessmentContent, HgaContent, HgaRule } from '../methodology/types';
import type { Responses } from './scoring';

export type ChangeState = 'Improved' | 'Resolved' | 'Persistent' | 'Worsened' | 'New';

export const REVIEW_REQUIRED = 'Cross-Version Comparison - Review Required';

export interface Snapshot {
  versions: { asm: string; scr: string; hga: string };
  hgiInternal: string;
  /** Category code -> internal score and internal percent (HGI categories). */
  categories: Record<string, { internal: string | null; percent: string | null }>;
  responses: Responses;
  itemPoints: Record<string, number | null>;
  findings: { ruleId: string; title: string; isSafety: boolean; source: string | null; priority: number | null }[];
}

export interface FindingChange {
  ruleId: string;
  title: string;
  state: ChangeState;
  measureLabel: string | null;
  baselineMeasure: number | null;
  currentMeasure: number | null;
  source: string | null;
  priority: number | null;
  isSafety: boolean;
  isContextual: boolean;
}

export interface ItemChange {
  itemCode: string;
  category: string;
  baseline: string;
  current: string;
  baselinePoints: number | null;
  currentPoints: number | null;
}

export interface ChangeResult {
  status: 'Comparable' | typeof REVIEW_REQUIRED;
  hgiBaseline: string | null;
  hgiCurrent: string | null;
  hgiChange: string | null; // internal precision (CHG-005)
  hgiChangeDisplay: string | null; // signed, one decimal
  categoryChanges: { category: string; baseline: string; current: string; change: string; changeDisplay: string }[];
  itemChanges: ItemChange[];
  contextualChanges: ItemChange[]; // Category 7, tracked outside HGI (CHG-015)
  findingChanges: FindingChange[];
}

const signed = (d: Decimal) => `${d.gte(0) ? '+' : ''}${d.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1)}`;

/** CHG-001..003: same versions, or a WeCanH2O-approved mapping for every differing family. */
export function isComparable(b: Snapshot['versions'], c: Snapshot['versions'], approvedMappings: ReadonlySet<string>) {
  return (['asm', 'scr', 'hga'] as const).every((k) => b[k] === c[k] || approvedMappings.has(`${b[k]}>${c[k]}`));
}

/** The measure a finding is judged by: the "low" side of its trigger (Milestone 3 Section 5.4). */
function measureOf(rule: HgaRule | undefined): { kind: 'item'; item: string } | { kind: 'category'; cat: string } | null {
  for (const c of rule?.when ?? []) {
    if (c.type === 'itemLow') return { kind: 'item', item: c.item };
    if (c.type === 'catLow') return { kind: 'category', cat: c.cat };
  }
  return null;
}

function label(asm: AssessmentContent, code: string, r: Responses[string] | undefined) {
  const item = asm.items.find((i) => i.itemCode === code);
  if (!r || r.state === 'blank') return 'Not answered';
  if (r.optionCodes) return r.optionCodes.map((c) => item?.options.find((o) => o.code === c)?.label ?? c).join('; ');
  return item?.options.find((o) => o.code === r.optionCode)?.label ?? String(r.optionCode);
}

const sameAnswer = (a: Responses[string] | undefined, b: Responses[string] | undefined) =>
  (a?.state ?? 'blank') === (b?.state ?? 'blank') && (a?.optionCode ?? null) === (b?.optionCode ?? null)
  && JSON.stringify(a?.optionCodes ?? null) === JSON.stringify(b?.optionCodes ?? null);

export function compareAssessments(
  asm: AssessmentContent,
  hga: HgaContent,
  baseline: Snapshot,
  current: Snapshot,
  approvedMappings: ReadonlySet<string> = new Set(),
): ChangeResult {
  if (!isComparable(baseline.versions, current.versions, approvedMappings)) {
    // No numbers and no states without an approved mapping (CHG-002, CHG-003, CHG-012).
    return { status: REVIEW_REQUIRED, hgiBaseline: null, hgiCurrent: null, hgiChange: null, hgiChangeDisplay: null,
      categoryChanges: [], itemChanges: [], contextualChanges: [], findingChanges: [] };
  }
  const threshold = hga.change ?? { categoryPctPoints: 10, itemLevels: 1 };

  // Overall HGI (CHG-004/005): internal values only.
  const hgiChange = new Decimal(current.hgiInternal).minus(baseline.hgiInternal);

  // Category change (CHG-007).
  const categoryChanges = Object.keys(baseline.categories)
    .filter((cat) => baseline.categories[cat].internal != null && current.categories[cat]?.internal != null)
    .sort()
    .map((cat) => {
      const d = new Decimal(current.categories[cat].internal!).minus(baseline.categories[cat].internal!);
      return { category: cat, baseline: baseline.categories[cat].internal!, current: current.categories[cat].internal!, change: d.toString(), changeDisplay: signed(d) };
    });

  // Item comparison side by side (CHG-008); Category 7 kept separate (CHG-015).
  const changed: ItemChange[] = asm.items
    .filter((i) => !sameAnswer(baseline.responses[i.itemCode], current.responses[i.itemCode]))
    .map((i) => ({
      itemCode: i.itemCode, category: i.category,
      baseline: label(asm, i.itemCode, baseline.responses[i.itemCode]),
      current: label(asm, i.itemCode, current.responses[i.itemCode]),
      baselinePoints: baseline.itemPoints[i.itemCode] ?? null,
      currentPoints: current.itemPoints[i.itemCode] ?? null,
    }));
  const contextualChanges = changed.filter((c) => c.category === 'C7');
  const itemChanges = changed.filter((c) => c.category !== 'C7');

  // Finding states (CHG-010, Milestone 3 Section 5.4).
  const ruleById = new Map(hga.rules.map((r) => [r.id, r]));
  const measureValue = (snap: Snapshot, m: NonNullable<ReturnType<typeof measureOf>>) => {
    if (m.kind === 'item') return snap.itemPoints[m.item] ?? null;
    const pct = snap.categories[m.cat]?.percent;
    return pct == null ? null : Number(new Decimal(pct).toDecimalPlaces(4));
  };
  const keys = new Set([...baseline.findings.map((f) => f.ruleId), ...current.findings.map((f) => f.ruleId)]);
  const findingChanges: FindingChange[] = [];
  for (const ruleId of keys) {
    const b = baseline.findings.find((f) => f.ruleId === ruleId);
    const c = current.findings.find((f) => f.ruleId === ruleId);
    const rule = ruleById.get(ruleId);
    const m = measureOf(rule);
    const ref = c ?? b!;
    const bm = m ? measureValue(baseline, m) : null;
    const cm = m ? measureValue(current, m) : null;
    let state: ChangeState;
    if (b && !c) state = 'Resolved';
    else if (!b && c) state = 'New';
    else if (m && bm != null && cm != null) {
      const delta = cm - bm;
      const step = m.kind === 'category' ? threshold.categoryPctPoints : threshold.itemLevels;
      state = delta >= step ? 'Improved' : delta <= -step ? 'Worsened' : 'Persistent';
    } else state = 'Persistent'; // present at both, no graded measure (e.g. a safety event)
    findingChanges.push({
      ruleId, title: ref.title, state,
      measureLabel: m ? (m.kind === 'item' ? m.item : `${m.cat} %`) : null,
      baselineMeasure: bm, currentMeasure: cm,
      source: ref.source, priority: c?.priority ?? b?.priority ?? null,
      isSafety: ref.isSafety,
      // Access / institutional and C7 changes are contextual, not athlete behavior (CHG-015, CHG-016).
      isContextual: ref.source === 'Institutional/Environmental' || ruleId === 'HGA-C7',
    });
  }
  // A new or persistent safety finding stays first even when HGI improves (CHG-013).
  const order: Record<ChangeState, number> = { New: 0, Worsened: 1, Persistent: 2, Improved: 3, Resolved: 4 };
  findingChanges.sort((x, y) =>
    Number(y.isSafety && y.state !== 'Resolved') - Number(x.isSafety && x.state !== 'Resolved')
    || order[x.state] - order[y.state]
    || (x.priority ?? 9) - (y.priority ?? 9)
    || x.ruleId.localeCompare(y.ruleId));

  return {
    status: 'Comparable',
    hgiBaseline: baseline.hgiInternal,
    hgiCurrent: current.hgiInternal,
    hgiChange: hgiChange.toString(),
    hgiChangeDisplay: signed(hgiChange),
    categoryChanges, itemChanges, contextualChanges, findingChanges,
  };
}
