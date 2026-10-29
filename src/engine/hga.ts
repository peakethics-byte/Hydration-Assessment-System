// Hydration Gap Analysis (HGA) rules engine (Milestone 3 Section 3). HGA is never a second score:
// it explains where gaps are, why, who can act and what priority each finding has.
import Decimal from 'decimal.js';
import type { AssessmentContent, Condition, HgaContent, HgaRule, ScoringContent, SourceClass } from '../methodology/types';
import type { Responses, ScoringResult } from './scoring';

export interface InstitutionContext {
  /** Recorded by the institution / WeCanH2O for the athlete's team. */
  heatSafetyProcedures: 'exist' | 'none' | 'unknown';
}

export interface Finding {
  ruleId: string;
  level: 'cross' | 'category' | 'item';
  title: string;
  source: SourceClass;
  priority: number;
  isSafety: boolean;
  tieBreakCategory: string;
  /** Inputs that satisfied the trigger, for traceability (TST-HGA-008). */
  inputs: Record<string, string | number | string[] | null>;
  rank: number;
}

export interface Strength {
  category: string;
  name: string;
  percent: string;
}

export interface HgaResult {
  findings: Finding[];
  strengths: Strength[];
  notes: { ruleId: string; note: string }[];
}

interface Ctx {
  asm: AssessmentContent;
  hga: HgaContent;
  responses: Responses;
  score: ScoringResult;
  institution: InstitutionContext;
  fired: Set<string>;
}

function itemPoints(ctx: Ctx, code: string) {
  return ctx.score.items.find((i) => i.itemCode === code)?.points ?? null;
}

function catPct(ctx: Ctx, cat: string): Decimal | null {
  const c = ctx.score.categories.find((x) => x.category === cat);
  return c?.percent ? new Decimal(c.percent) : null;
}

function evaluate(ctx: Ctx, cond: Condition, inputs: Finding['inputs']): boolean {
  const t = ctx.hga.thresholds;
  switch (cond.type) {
    case 'itemLow':
    case 'itemHigh': {
      const p = itemPoints(ctx, cond.item);
      inputs[cond.item] = p;
      if (p == null) return false;
      return cond.type === 'itemLow' ? p <= t.lowItemMaxPoints : p >= t.highItemMinPoints;
    }
    case 'catLow':
    case 'catHigh': {
      const pct = catPct(ctx, cond.cat);
      inputs[`${cond.cat}%`] = pct ? pct.toDecimalPlaces(1).toNumber() : null;
      if (!pct) return false;
      return cond.type === 'catLow' ? pct.lte(t.lowCategoryMaxPct) : pct.gte(t.strongCategoryMinPct);
    }
    case 'optionIn': {
      const r = ctx.responses[cond.item];
      inputs[cond.item] = r?.optionCode ?? null;
      return r?.state === 'value' && r.optionCode != null && cond.codes.includes(r.optionCode);
    }
    case 'anySelected': {
      const r = ctx.responses[cond.item];
      const codes = r?.optionCodes ?? [];
      inputs[cond.item] = codes;
      return r?.state === 'value' && codes.some((c) => !cond.exclude.includes(c));
    }
    case 'anyItemOption': {
      const hits = cond.items.filter((code) => {
        const r = ctx.responses[code];
        return r?.state === 'value' && r.optionCode != null && cond.codes.includes(r.optionCode);
      });
      inputs[cond.items.join(',')] = hits;
      return hits.length > 0;
    }
    case 'institutionFlag': {
      inputs[`institution.${cond.flag}`] = ctx.institution.heatSafetyProcedures;
      return ctx.institution.heatSafetyProcedures === cond.equals;
    }
    case 'notFired':
      return cond.rules.every((r) => !ctx.fired.has(r));
  }
}

function tieBreak(hga: HgaContent, ctx: Ctx) {
  const levelIdx = (l: Finding['level']) => hga.levelOrder.indexOf(l);
  const pct = (cat: string) => catPct(ctx, cat)?.toNumber() ?? 100;
  const catOrder = (cat: string) => Number(cat.replace(/\D/g, '')) || 99;
  return (a: Finding, b: Finding) =>
    a.priority - b.priority ||
    levelIdx(a.level) - levelIdx(b.level) ||
    pct(a.tieBreakCategory) - pct(b.tieBreakCategory) ||
    catOrder(a.tieBreakCategory) - catOrder(b.tieBreakCategory) ||
    a.ruleId.localeCompare(b.ruleId);
}

export function runHga(
  asm: AssessmentContent,
  _scoring: ScoringContent,
  hga: HgaContent,
  responses: Responses,
  score: ScoringResult,
  institution: InstitutionContext,
  /** Rule IDs found at the previous comparable assessment (for "persistent" priority class 4). */
  priorFindings: ReadonlySet<string> = new Set(),
): HgaResult {
  if (score.status !== 'scored') throw new Error('HGA runs only on a Complete / Scored assessment');
  const ctx: Ctx = { asm, hga, responses, score, institution, fired: new Set() };
  const notes: HgaResult['notes'] = [];
  const firedRules: { rule: HgaRule; inputs: Finding['inputs'] }[] = [];

  // Rules are evaluated in their listed order so "notFired" conditions see earlier results.
  for (const rule of hga.rules) {
    const blankFollowUp = rule.followUps?.filter((code) => (responses[code]?.state ?? 'blank') === 'blank') ?? [];
    if (blankFollowUp.length) {
      notes.push({ ruleId: rule.id, note: `Not evaluable - follow-up not answered (${blankFollowUp.join(', ')})` });
      continue;
    }
    const inputs: Finding['inputs'] = {};
    if (rule.when.every((c) => evaluate(ctx, c, inputs))) {
      ctx.fired.add(rule.id);
      firedRules.push({ rule, inputs });
    }
  }

  const findings: Finding[] = firedRules.map(({ rule, inputs }) => {
    const override = rule.priorityWhenFired?.find((p) => ctx.fired.has(p.rule));
    const persistent = rule.priorityWhenPersistent != null && priorFindings.has(rule.id);
    return {
      ruleId: rule.id,
      level: rule.level,
      title: rule.title,
      source: rule.source,
      priority: override?.priority ?? (persistent ? rule.priorityWhenPersistent! : rule.priority),
      isSafety: rule.isSafety,
      tieBreakCategory: rule.tieBreakCategory,
      inputs,
      rank: 0,
    };
  });
  findings.sort(tieBreak(hga, ctx));
  findings.forEach((f, i) => (f.rank = i + 1));

  const strengths: Strength[] = hga.strengths.categories.flatMap((code) => {
    const c = score.categories.find((x) => x.category === code);
    const pct = c?.percent ? new Decimal(c.percent) : null;
    return pct && pct.gte(hga.strengths.minPct)
      ? [{ category: code, name: c!.name, percent: pct.toDecimalPlaces(1).toFixed(1) }]
      : [];
  });

  return { findings, strengths, notes };
}

// ---- Hydration Profile (Milestone 3 Section 3.7): built only from existing answers ----
export interface HydrationProfile {
  circadianBaseline: { item: string; answer: string }[];
  activityDemand: { item: string; answer: string }[];
  triggersEnvironment: { item: string; answer: string }[];
  individualFactors: { item: string; answer: string }[];
  identifiedGaps: { findings: string[]; strengths: string[] };
}

export function buildProfile(asm: AssessmentContent, responses: Responses, hgaResult: HgaResult): HydrationProfile {
  const answer = (code: string) => {
    const item = asm.items.find((i) => i.itemCode === code)!;
    const r = responses[code];
    if (!r || r.state === 'blank') return { item: code, answer: 'Not answered' };
    if (item.multiSelect) {
      return { item: code, answer: (r.optionCodes ?? []).map((c) => item.options.find((o) => o.code === c)?.label ?? c).join('; ') };
    }
    return { item: code, answer: item.options.find((o) => o.code === r.optionCode)?.label ?? String(r.optionCode) };
  };
  return {
    circadianBaseline: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map(answer),
    activityDemand: ['Q11A', 'Q11B'].map(answer),
    triggersEnvironment: ['Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11B', 'Q17', 'Q21'].map(answer),
    individualFactors: ['Q18', 'Q19', 'Q20', 'Q22', 'Q33', 'Q34', 'Q35', 'Q36', 'Q37'].map(answer),
    identifiedGaps: {
      findings: hgaResult.findings.map((f) => f.title),
      strengths: hgaResult.strengths.map((s) => s.name),
    },
  };
}
