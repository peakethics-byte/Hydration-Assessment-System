// Scoring engine (Milestone 3 Sections 1-2). Pure and deterministic: same responses + same rule
// versions always give the same result. Runs on the server only.
import Decimal from 'decimal.js';
import type { AssessmentContent, AssessmentItem, ScoringContent } from '../methodology/types';

export type ResponseState = 'blank' | 'value' | 'na' | 'prefer_not';

export interface ItemResponse {
  state: ResponseState;
  optionCode?: string; // single-select
  optionCodes?: string[]; // multi-select (Q32A)
}

export type Responses = Record<string, ItemResponse>;

export type AssessmentStatus = 'scored' | 'incomplete' | 'insufficient_c4';

export interface CategoryResult {
  category: string;
  name: string;
  max: number;
  raw: number | null; // earned points
  applicableMax: number | null;
  applicableCount: number | null;
  internal: string | null; // full precision decimal string
  display: string | null; // one decimal
  percent: string | null; // internal category %, for HGA only
  status: 'Scored' | 'Insufficient Data' | 'Contextual' | 'Not Calculated';
}

export interface ItemScore {
  itemCode: string;
  construct: string;
  state: ResponseState;
  optionCode: string | null;
  optionCodes: string[] | null;
  points: number | null;
  scored: boolean;
}

export interface ScoringResult {
  status: AssessmentStatus;
  statusLabel: string;
  missingItems: string[];
  invalidItems: string[];
  c4ApplicableCount: number;
  items: ItemScore[];
  derived: { C3Q4: number | null };
  categories: CategoryResult[];
  hgi: { internal: string; display: string; band: string } | null;
}

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function roundDisplay(value: Decimal, places = 1): Decimal {
  return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}

/** Band is assigned from the displayed one-decimal value (client decision, Oct 8 2026). */
export function bandFor(display: Decimal, scoring: ScoringContent): string {
  for (const b of scoring.bands) if (display.gte(b.min)) return b.label;
  return scoring.bands[scoring.bands.length - 1].label;
}

/** Display value and band for an internal HGI (used by the boundary/rounding tests too). */
export function classifyHgi(internal: Decimal.Value, scoring: ScoringContent) {
  const display = roundDisplay(new Decimal(internal), scoring.rounding.places);
  return { display: display.toFixed(scoring.rounding.places), band: bandFor(display, scoring) };
}

function pointsOf(item: AssessmentItem, r: ItemResponse | undefined): number | null {
  if (!r || r.state !== 'value' || r.optionCode == null) return null;
  const opt = item.options.find((o) => o.code === r.optionCode);
  return opt?.points ?? null;
}

/** Checks a response against the item definition. Returns an error string or null. */
export function checkResponse(item: AssessmentItem, r: ItemResponse | undefined): string | null {
  if (!r || r.state === 'blank') return null;
  if (r.state === 'na') {
    if (!item.naAllowed) return 'N/A is not an approved answer for this item';
    return null;
  }
  if (r.state === 'prefer_not') {
    if (!item.optional) return 'Prefer not to answer is only available in Part 7';
    return null;
  }
  if (item.multiSelect) {
    const codes = r.optionCodes ?? [];
    if (codes.length === 0) return 'No option selected';
    if (codes.some((c) => !item.options.some((o) => o.code === c))) return 'Unknown option';
    const none = item.options.find((o) => o.kind === 'none_of_these');
    if (none && codes.includes(none.code) && codes.length > 1) return '"None of these" cannot be combined with other answers';
    return null;
  }
  const opt = item.options.find((o) => o.code === r.optionCode);
  if (!opt) return 'Unknown option';
  if (opt.kind === 'na' || opt.kind === 'prefer_not') return 'Option stored with the wrong state';
  return null;
}

/** Normalizes a raw answer (from a form or fixture) to a stored response state. */
export function normalizeAnswer(item: AssessmentItem, raw: string | string[] | undefined | null): ItemResponse {
  if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) return { state: 'blank' };
  if (item.multiSelect) return { state: 'value', optionCodes: Array.isArray(raw) ? raw : [raw] };
  const code = Array.isArray(raw) ? raw[0] : raw;
  const opt = item.options.find((o) => o.code === code);
  if (opt?.kind === 'na') return { state: 'na', optionCode: code };
  if (opt?.kind === 'prefer_not') return { state: 'prefer_not', optionCode: code };
  return { state: 'value', optionCode: code };
}

export function scoreAssessment(asm: AssessmentContent, scoring: ScoringContent, responses: Responses): ScoringResult {

  // 1. Item scores (blank, value, N/A and Prefer not to answer stay distinct).
  const items: ItemScore[] = asm.items.map((item) => {
    const r = responses[item.itemCode] ?? { state: 'blank' as const };
    return {
      itemCode: item.itemCode,
      construct: item.construct,
      state: r.state,
      optionCode: r.optionCode ?? null,
      optionCodes: r.optionCodes ?? null,
      points: pointsOf(item, r),
      scored: item.type === 'scored' || item.type === 'component',
    };
  });
  const pts = new Map(items.map((s) => [s.itemCode, s.points]));

  // 2. Validation: required items answered (or approved N/A); answers valid.
  const missingItems: string[] = [];
  const invalidItems: string[] = [];
  for (const item of asm.items) {
    const r = responses[item.itemCode];
    if (checkResponse(item, r)) invalidItems.push(item.itemCode);
    if (item.required && (!r || r.state === 'blank')) missingItems.push(item.itemCode);
  }

  // C4 applicable count (answered with a value, N/A excluded).
  const c4Def = scoring.categories.find((c) => c.method.kind === 'normalized');
  const c4ApplicableCount = c4Def ? c4Def.method.items.filter((code) => pts.get(code) != null).length : 0;

  const c3q4 = (() => {
    const c3 = scoring.categories.find((c) => c.method.kind === 'sum_with_lower_of');
    if (!c3 || c3.method.kind !== 'sum_with_lower_of') return null;
    const [a, b] = c3.method.lowerOf.items.map((code) => pts.get(code));
    return a == null || b == null ? null : Math.min(a, b);
  })();

  const incomplete = missingItems.length > 0 || invalidItems.length > 0;
  const insufficientC4 = !incomplete && c4Def?.method.kind === 'normalized' && c4ApplicableCount < c4Def.method.minApplicable;

  // 3. Category scores at full internal precision.
  const categories: CategoryResult[] = scoring.categories.map((cat) => {
    const base = { category: cat.code, name: cat.name, max: cat.max };
    const m = cat.method;
    if (m.kind === 'contextual') {
      return { ...base, raw: null, applicableMax: null, applicableCount: null, internal: null, display: null, percent: null, status: 'Contextual' };
    }
    const vals = m.items.map((code) => pts.get(code));
    let raw: number | null = null;
    let applicableMax: number | null = cat.max;
    let applicableCount: number | null = m.items.length;
    let value: Decimal | null = null;
    let status: CategoryResult['status'] = 'Scored';

    if (m.kind === 'sum') {
      if (vals.every((v) => v != null)) {
        raw = vals.reduce<number>((s, v) => s + (v as number), 0);
        value = new Decimal(raw);
      }
    } else if (m.kind === 'sum_with_lower_of') {
      if (vals.every((v) => v != null) && c3q4 != null) {
        raw = vals.reduce<number>((s, v) => s + (v as number), 0) + c3q4;
        value = new Decimal(raw);
      }
    } else if (m.kind === 'normalized') {
      const applicable = vals.filter((v): v is number => v != null);
      applicableCount = applicable.length;
      applicableMax = applicable.length * m.perItemMax;
      raw = applicable.reduce((s, v) => s + v, 0);
      if (applicable.length < m.minApplicable) status = 'Insufficient Data';
      else value = new Decimal(raw).div(applicableMax).mul(cat.max);
    } else if (m.kind === 'scaled') {
      if (vals.every((v) => v != null)) {
        raw = vals.reduce<number>((s, v) => s + (v as number), 0);
        applicableMax = m.rawMax;
        value = new Decimal(raw).div(m.rawMax).mul(cat.max);
      }
    }
    if (value == null && status === 'Scored') status = 'Not Calculated';
    return {
      ...base,
      raw,
      applicableMax,
      applicableCount,
      internal: value ? value.toString() : null,
      display: value ? roundDisplay(value, scoring.rounding.places).toFixed(scoring.rounding.places) : null,
      percent: value ? value.div(cat.max).mul(100).toString() : null,
      status,
    };
  });

  // 4. HGI only when every rule is met; never partial, prorated or estimated.
  let hgi: ScoringResult['hgi'] = null;
  let status: AssessmentStatus = 'scored';
  if (incomplete) status = 'incomplete';
  else if (insufficientC4) status = 'insufficient_c4';
  else {
    const total = scoring.hgiCategories.reduce((sum, code) => {
      const c = categories.find((x) => x.category === code)!;
      return sum.plus(new Decimal(c.internal!));
    }, new Decimal(0));
    hgi = { internal: total.toString(), ...classifyHgi(total, scoring) };
  }

  const statusLabel =
    status === 'incomplete' ? scoring.statusLabels.incomplete
    : status === 'insufficient_c4' ? scoring.statusLabels.insufficientC4
    : scoring.statusLabels.scored;

  // Missing items are reported in Document #2 order.
  const order = (code: string) => asm.items.findIndex((i) => i.itemCode === code);
  missingItems.sort((a, b) => order(a) - order(b));

  return { status, statusLabel, missingItems, invalidItems, c4ApplicableCount, items, derived: { C3Q4: c3q4 }, categories, hgi };
}
