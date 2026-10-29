// Change engine against the Milestone 3 Section 6.4 reassessment / change pairs (fictional fixtures).
import { describe, expect, it } from 'vitest';
import { A_ASM_1_0 } from '@/src/methodology/a-asm-1.0';
import { A_SCR_1_0 } from '@/src/methodology/a-scr-1.0';
import { A_HGA_1_0 } from '@/src/methodology/a-hga-1.0';
import { normalizeAnswer, scoreAssessment, type Responses } from '@/src/engine/scoring';
import { runHga } from '@/src/engine/hga';
import { compareAssessments, REVIEW_REQUIRED, type Snapshot } from '@/src/engine/change';
import { BASE, PROFILES, type RawAnswers } from '@/src/testing/fixtures';

const V = { asm: 'A-ASM-1.0', scr: 'A-SCR-1.0', hga: 'A-HGA-1.0' };
const profile = (id: string) => PROFILES.find((p) => p.id === id)!.answers;
const C1 = (v: string) => Object.fromEntries(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map((q) => [q, v]));

function snap(raw: RawAnswers, versions = V): Snapshot {
  const responses: Responses = Object.fromEntries(A_ASM_1_0.items.map((i) => [i.itemCode, normalizeAnswer(i, raw[i.itemCode])]));
  const s = scoreAssessment(A_ASM_1_0, A_SCR_1_0, responses);
  const h = runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, responses, s, { heatSafetyProcedures: 'exist' });
  return {
    versions,
    hgiInternal: s.hgi!.internal,
    categories: Object.fromEntries(s.categories.filter((c) => A_SCR_1_0.hgiCategories.includes(c.category))
      .map((c) => [c.category, { internal: c.internal, percent: c.percent }])),
    responses,
    itemPoints: Object.fromEntries(s.items.map((i) => [i.itemCode, i.points])),
    findings: h.findings.map((f) => ({ ruleId: f.ruleId, title: f.title, isSafety: f.isSafety, source: f.source, priority: f.priority })),
  };
}
const compare = (b: RawAnswers, c: RawAnswers, cv = V) => compareAssessments(A_ASM_1_0, A_HGA_1_0, snap(b), snap(c, cv));
const state = (r: ReturnType<typeof compare>, rule: string) => r.findingChanges.find((f) => f.ruleId === rule)?.state;

describe('Reassessment / change pairs (Milestone 3 Section 6.4)', () => {
  it('TST-CHG-001 Improved: C1 0% -> 25%, still low', () => {
    const r = compare({ ...BASE, ...C1('0') }, { ...BASE, ...C1('1') });
    expect(state(r, 'HGA-C1')).toBe('Improved');
    expect(state(r, 'HGA-X03')).toBe('Improved');
    expect(r.hgiChangeDisplay).toBe('+5.0');
  });
  it('TST-CHG-002 Resolved: Profile B -> Profile A', () => {
    const r = compare(profile('B'), profile('A'));
    expect(state(r, 'HGA-X03')).toBe('Resolved');
    expect(state(r, 'HGA-C1')).toBe('Resolved');
    expect(r.hgiChangeDisplay).toBe('+20.0');
  });
  it('TST-CHG-003 Persistent: Profile C -> Profile C', () => {
    const r = compare(profile('C'), profile('C'));
    expect(state(r, 'HGA-C2')).toBe('Persistent');
    expect(r.hgiChangeDisplay).toBe('+0.0');
  });
  it('TST-CHG-004 Worsened: C1 50% -> 0%', () => {
    const r = compare({ ...BASE, ...C1('2') }, { ...BASE, ...C1('0') });
    expect(state(r, 'HGA-C1')).toBe('Worsened');
    expect(state(r, 'HGA-X03')).toBe('Worsened');
    expect(r.hgiChangeDisplay).toBe('-10.0');
  });
  it('TST-CHG-005 New: Profile A -> Profile B', () => {
    const r = compare(profile('A'), profile('B'));
    expect(state(r, 'HGA-X03')).toBe('New');
    expect(state(r, 'HGA-C1')).toBe('New');
    expect(r.hgiChangeDisplay).toBe('-20.0');
  });
  it('TST-CHG-006 HGI delta from internal values: Profile H -> Profile A = +37.5', () => {
    const r = compare(profile('H'), profile('A'));
    expect(r.hgiChange).toBe('37.5');
    expect(r.findingChanges.every((f) => f.state === 'Resolved')).toBe(true);
  });
  it('TST-CHG-007 Safety despite improvement: Profile B -> Profile E', () => {
    const r = compare(profile('B'), profile('E'));
    expect(r.hgiChangeDisplay).toBe('+19.0');
    expect(state(r, 'HGA-X03')).toBe('Resolved');
    expect(r.findingChanges[0]).toMatchObject({ ruleId: 'HGA-X05', state: 'New', isSafety: true }); // first priority
  });
  it('TST-CHG-008 Cross-version without a mapping: Review Required, no numbers or states', () => {
    const r = compare(profile('A'), profile('A'), { ...V, asm: 'A-ASM-9.9' });
    expect(r.status).toBe(REVIEW_REQUIRED);
    expect(r.hgiChange).toBeNull();
    expect(r.findingChanges).toHaveLength(0);
  });
  it('An approved WeCanH2O mapping makes different versions comparable', () => {
    const r = compareAssessments(A_ASM_1_0, A_HGA_1_0, snap(profile('A')), snap(profile('A'), { ...V, asm: 'A-ASM-9.9' }), new Set(['A-ASM-1.0>A-ASM-9.9']));
    expect(r.status).toBe('Comparable');
  });
  it('TST-CHG-010 C7 change: Profile I2 -> Profile I1 is tracked outside HGI', () => {
    const r = compare(profile('I2'), profile('I1'));
    expect(r.hgiChangeDisplay).toBe('+0.0');
    expect(r.contextualChanges.map((c) => c.itemCode)).toEqual(['Q33', 'Q34', 'Q35', 'Q36', 'Q37']);
    expect(r.itemChanges).toHaveLength(0);
    expect(r.findingChanges.find((f) => f.ruleId === 'HGA-C7')).toMatchObject({ state: 'New', isContextual: true });
  });
  it('Access barrier improving is reported as contextual, not athlete behavior (CHG-016)', () => {
    const r = compare(profile('C'), profile('A'));
    expect(r.findingChanges.find((f) => f.ruleId === 'HGA-C2')).toMatchObject({ state: 'Resolved', isContextual: true });
  });
  it('TST-CHG-003 (Doc 4): an improved item can coexist with a Persistent finding', () => {
    // C1 from all 0 to one answer at 2 (+10%): HGA-C1 moves 0% -> 10%, i.e. exactly the 10-point step -> Improved;
    // a smaller move (one answer at 1, +5%) stays Persistent while the item itself improved.
    const r = compare({ ...BASE, ...C1('0') }, { ...BASE, ...C1('0'), Q1: '1' });
    expect(state(r, 'HGA-C1')).toBe('Persistent');
    expect(r.itemChanges.map((c) => c.itemCode)).toEqual(['Q1']);
  });
});

describe('Persistent priority class 4 (Milestone 3 Section 3.6)', () => {
  it('a repeated behavioral gap gets class 4 from the second assessment onward', () => {
    const raw = profile('B');
    const responses: Responses = Object.fromEntries(A_ASM_1_0.items.map((i) => [i.itemCode, normalizeAnswer(i, raw[i.itemCode])]));
    const s = scoreAssessment(A_ASM_1_0, A_SCR_1_0, responses);
    const first = runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, responses, s, { heatSafetyProcedures: 'exist' });
    const again = runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, responses, s, { heatSafetyProcedures: 'exist' }, new Set(['HGA-C1', 'HGA-X03']));
    expect(first.findings.find((f) => f.ruleId === 'HGA-C1')?.priority).toBe(6);
    expect(again.findings.find((f) => f.ruleId === 'HGA-C1')?.priority).toBe(4);
    expect(again.findings.find((f) => f.ruleId === 'HGA-X03')?.priority).toBe(5); // not a "persistent" rule
    expect(again.findings.map((f) => f.ruleId)).toEqual(['HGA-C1', 'HGA-X03']); // class 4 now ranks first
  });
});
