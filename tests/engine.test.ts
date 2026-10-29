// Unit tests of the pure engines against the gold-standard fixtures (Document #8).
import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { A_ASM_1_0 } from '@/src/methodology/a-asm-1.0';
import { A_SCR_1_0 } from '@/src/methodology/a-scr-1.0';
import { A_HGA_1_0 } from '@/src/methodology/a-hga-1.0';
import { A_REC_1_0 } from '@/src/methodology/a-rec-1.0';
import { classifyHgi, normalizeAnswer, scoreAssessment, type Responses } from '@/src/engine/scoring';
import { runHga } from '@/src/engine/hga';
import { suggestRecommendations } from '@/src/engine/ihs';
import { BASE, C3Q4_CASES, C4_CASES, HGI_CASES, PROFILES, type RawAnswers } from '@/src/testing/fixtures';

function toResponses(raw: RawAnswers): Responses {
  return Object.fromEntries(A_ASM_1_0.items.map((i) => [i.itemCode, normalizeAnswer(i, raw[i.itemCode])]));
}
const score = (raw: RawAnswers) => scoreAssessment(A_ASM_1_0, A_SCR_1_0, toResponses(raw));
const NO_FLAG = { heatSafetyProcedures: 'exist' as const };

describe('Gold-standard profiles A-J', () => {
  for (const p of PROFILES) {
    it(`Profile ${p.id} - ${p.name}`, () => {
      const responses = toResponses(p.answers);
      const s = scoreAssessment(A_ASM_1_0, A_SCR_1_0, responses);
      expect(s.status).toBe(p.expected.status);
      if (p.expected.status !== 'scored') {
        expect(s.hgi).toBeNull();
        expect(s.missingItems).toEqual(p.expected.missing);
        // Blank is never converted to zero (TST-GS-J2).
        expect(s.items.find((i) => i.itemCode === 'Q6')?.points).toBeNull();
        return;
      }
      for (const [cat, val] of Object.entries(p.expected.categories!)) {
        expect(s.categories.find((c) => c.category === cat)?.display, cat).toBe(val);
      }
      expect(s.hgi?.display).toBe(p.expected.hgiDisplay);
      expect(s.hgi?.band).toBe(p.expected.band);
      const h = runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, responses, s, NO_FLAG);
      expect(h.findings.map((f) => [f.ruleId, f.priority])).toEqual(p.expected.findings);
      expect(h.strengths.map((x) => x.category)).toEqual(p.expected.strengths);
      const recs = suggestRecommendations(A_REC_1_0, h.findings);
      expect(recs.some((r) => r.pathway === 'F')).toBe(false); // no product shortcut
      for (const [rule, pathway] of Object.entries(p.expected.pathways ?? {})) {
        expect(recs.find((r) => r.ruleId === rule)?.pathway, rule).toBe(pathway);
      }
    });
  }

  it('TST-GS-D1 / I1: paired records have identical HGI', () => {
    const d1 = score(PROFILES.find((p) => p.id === 'D1')!.answers);
    const d2 = score(PROFILES.find((p) => p.id === 'D2')!.answers);
    expect(d1.hgi?.internal).toBe(d2.hgi?.internal);
    const i1 = score(PROFILES.find((p) => p.id === 'I1')!.answers);
    const i2 = score(PROFILES.find((p) => p.id === 'I2')!.answers);
    expect(i1.hgi?.internal).toBe(i2.hgi?.internal);
  });

  it('TST-HGA-007: repeated runs are identical', () => {
    const p = PROFILES.find((x) => x.id === 'H')!;
    const r = toResponses(p.answers);
    const runs = [1, 2, 3].map(() => JSON.stringify(runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, r, scoreAssessment(A_ASM_1_0, A_SCR_1_0, r), NO_FLAG)));
    expect(new Set(runs).size).toBe(1);
  });
});

describe('Category 4 normalization (TST-C4)', () => {
  for (const c of C4_CASES) {
    it(c.id, () => {
      const s = score({ ...BASE, ...c.answers } as RawAnswers);
      expect(s.status).toBe(c.expected.status);
      const c4 = s.categories.find((x) => x.category === 'C4')!;
      if (c.expected.display) {
        expect(c4.display).toBe(c.expected.display);
        expect(new Decimal(c4.internal!).toDecimalPlaces(12).toString()).toBe(new Decimal(c.expected.internal!).toDecimalPlaces(12).toString());
      }
      if (c.expected.status === 'insufficient_c4') {
        expect(c4.status).toBe('Insufficient Data');
        expect(s.hgi).toBeNull();
      }
    });
  }
});

describe('C3Q4 lower-of (TST-C3Q4)', () => {
  for (const c of C3Q4_CASES) {
    it(c.id, () => {
      const s = score({ ...BASE, Q15A: c.q15a, Q15B: c.q15b });
      expect(s.derived.C3Q4).toBe(c.expected);
      // Both answers are kept (TST-C3Q4-006).
      expect(s.items.find((i) => i.itemCode === 'Q15A')?.points).toBe(Number(c.q15a));
      expect(s.items.find((i) => i.itemCode === 'Q15B')?.points).toBe(Number(c.q15b));
    });
  }

  it('TST-C3Q4-008: no-procedure institution gets an institutional flag, not an athlete penalty', () => {
    const r = toResponses({ ...BASE, Q15A: '0', Q15B: '0' });
    const s = scoreAssessment(A_ASM_1_0, A_SCR_1_0, r);
    const withProc = runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, r, s, { heatSafetyProcedures: 'exist' });
    const noProc = runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, r, s, { heatSafetyProcedures: 'none' });
    expect(withProc.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['HGA-C3Q4A', 'HGA-C3Q4B']));
    expect(noProc.findings.map((f) => f.ruleId)).toContain('HGA-INST-PROC');
    expect(noProc.findings.map((f) => f.ruleId)).not.toContain('HGA-C3Q4B');
    expect(s.categories.find((c) => c.category === 'C3')?.display).toBe('12.0'); // scoring unchanged
  });
});

describe('HGI boundaries and rounding (TST-HGI)', () => {
  for (const c of HGI_CASES) {
    it(`${c.id}: ${c.internal} -> ${c.display} ${c.band}`, () => {
      expect(classifyHgi(c.internal, A_SCR_1_0)).toEqual({ display: c.display, band: c.band });
    });
  }
});

describe('HGA cross-category rules (TST-HGA)', () => {
  const findings = (raw: RawAnswers) => {
    const r = toResponses(raw);
    return runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, r, scoreAssessment(A_ASM_1_0, A_SCR_1_0, r), NO_FLAG).findings.map((f) => f.ruleId);
  };
  it('TST-HGA-001 low C3Q2 + strong C2 -> X01', () => expect(findings({ ...BASE, Q13: '0' })).toContain('HGA-X01'));
  it('TST-HGA-002 low C3Q2 + low C2 -> X02, not X01', () => {
    const f = findings({ ...BASE, Q13: '0', Q6: '0', Q7: '0', Q8: '0', Q9: '0', Q10: '0' });
    expect(f).toContain('HGA-X02');
    expect(f).not.toContain('HGA-X01');
  });
  it('Middle C2: neither X01 nor X02; low C3Q2 reported at item level', () => {
    const f = findings({ ...BASE, Q13: '0', Q6: '2', Q7: '2', Q8: '2', Q9: '1', Q10: '1' }); // C2 = 8 (53%)
    expect(f).not.toContain('HGA-X01');
    expect(f).not.toContain('HGA-X02');
    expect(f).toContain('HGA-C3Q2');
  });
  it('Blank follow-up makes X05 not evaluable without blocking HGI', () => {
    const r = toResponses({ ...BASE, Q32: '1', Q32A: null, Q32B: null });
    const s = scoreAssessment(A_ASM_1_0, A_SCR_1_0, r);
    expect(s.status).toBe('scored');
    const h = runHga(A_ASM_1_0, A_SCR_1_0, A_HGA_1_0, r, s, NO_FLAG);
    expect(h.notes.some((n) => n.ruleId === 'HGA-X05')).toBe(true);
  });
});

describe('Validation', () => {
  it('rejects N/A on an item without an approved N/A', () => {
    const s = score({ ...BASE, Q17: 'NA' });
    expect(s.status).toBe('incomplete');
    expect(s.invalidItems).toContain('Q17');
  });
  it('rejects "None of these" combined with a symptom', () => {
    expect(score({ ...BASE, Q32A: ['none', 'dizziness'] }).invalidItems).toContain('Q32A');
  });
});
