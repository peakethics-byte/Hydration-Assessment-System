// Gold-standard fixtures (Document #8; Milestone 3 Section 6). All records are fictional.
// Expected values were calculated by hand, independently of the system (TST-001, TST-004).
// Answers use option codes: for scored items the code is the hidden point value.

export type RawAnswers = Record<string, string | string[] | null>;

/** Milestone 3 Section 6.1 base answer set. */
export const BASE: RawAnswers = {
  Q1: '4', Q2: '4', Q3: '4', Q4: '4', Q5: '4',
  Q6: '3', Q7: '3', Q8: '3', Q9: '3', Q10: '3',
  Q11A: '10-14', Q11B: '2-5',
  Q12: '3', Q13: '3', Q14: '3', Q15A: '3', Q15B: '3', Q16: '3', Q16A: 'yes',
  Q17: '3', Q18: '3', Q19: '3', Q20: '3', Q21: '3', Q22: '3',
  Q23: '3', Q24: '3', Q25: '3', Q26: '3', Q27: '3',
  Q28: '2', Q29: '2', Q30: '2', Q31: '2', Q32: '2', Q32A: ['none'], Q32B: 'na',
  Q33: '2', Q34: '2', Q35: '2', Q36: '2', Q37: '2',
  Q38: '3', Q39: '3', Q40: '3', Q41: '3', Q42: '3',
};

const set = (codes: string[], value: string) => Object.fromEntries(codes.map((c) => [c, value]));
const C1 = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
const C2 = ['Q6', 'Q7', 'Q8', 'Q9', 'Q10'];
const C5 = ['Q23', 'Q24', 'Q25', 'Q26', 'Q27'];
const C7 = ['Q33', 'Q34', 'Q35', 'Q36', 'Q37'];
const C8 = ['Q38', 'Q39', 'Q40', 'Q41', 'Q42'];

export interface Expected {
  status: 'scored' | 'incomplete' | 'insufficient_c4';
  categories?: Record<'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C8', string>;
  hgiDisplay?: string;
  band?: string;
  /** Findings in expected priority order (rule ID, priority class). */
  findings?: [string, number][];
  strengths?: string[];
  pathways?: Record<string, string>;
  missing?: string[];
}

export interface Profile {
  id: string;
  name: string;
  testIds: string[];
  answers: RawAnswers;
  expected: Expected;
  draftFixture: boolean; // true where Milestone 3 completed the fixture (DRAFT)
}

const ALL_STRENGTHS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C8'];
const cats = (c1: string, c2: string, c3: string, c4: string, c5: string, c6: string, c8: string) =>
  ({ C1: c1, C2: c2, C3: c3, C4: c4, C5: c5, C6: c6, C8: c8 });

export const PROFILES: Profile[] = [
  { id: 'A', name: 'Strong alignment', testIds: ['TST-GS-A1', 'TST-GS-A2', 'TST-GS-A3'], draftFixture: false,
    answers: { ...BASE },
    expected: { status: 'scored', categories: cats('20.0', '15.0', '15.0', '15.0', '10.0', '10.0', '15.0'), hgiDisplay: '100.0', band: 'Minimal Gap',
      findings: [], strengths: ALL_STRENGTHS } },
  { id: 'B', name: 'Knowledge-to-action', testIds: ['TST-GS-B1', 'TST-GS-B2', 'TST-GS-B3', 'TST-GS-B4'], draftFixture: false,
    answers: { ...BASE, ...set(C1, '0') },
    expected: { status: 'scored', categories: cats('0.0', '15.0', '15.0', '15.0', '10.0', '10.0', '15.0'), hgiDisplay: '80.0', band: 'Mild Gap',
      findings: [['HGA-X03', 5], ['HGA-C1', 6]], strengths: ['C2', 'C3', 'C4', 'C5', 'C6', 'C8'],
      pathways: { 'HGA-X03': 'B', 'HGA-C1': 'B' } } },
  { id: 'C', name: 'Access barrier', testIds: ['TST-GS-C1', 'TST-GS-C2', 'TST-GS-C3'], draftFixture: false,
    answers: { ...BASE, ...set(C2, '0') },
    expected: { status: 'scored', categories: cats('20.0', '0.0', '15.0', '15.0', '10.0', '10.0', '15.0'), hgiDisplay: '85.0', band: 'Mild Gap',
      findings: [['HGA-C2', 2]], strengths: ['C1', 'C3', 'C4', 'C5', 'C6', 'C8'], pathways: { 'HGA-C2': 'C' } } },
  { id: 'D1', name: 'High exposure, weak adaptation', testIds: ['TST-GS-D1', 'TST-GS-D2', 'TST-GS-D3'], draftFixture: true,
    answers: { ...BASE, Q11B: '10+', Q17: '0' },
    expected: { status: 'scored', categories: cats('20.0', '15.0', '15.0', '12.5', '10.0', '10.0', '15.0'), hgiDisplay: '97.5', band: 'Minimal Gap',
      findings: [['HGA-X06', 3], ['HGA-C4Q1', 3]], strengths: ALL_STRENGTHS, pathways: { 'HGA-X06': 'D', 'HGA-C4Q1': 'B' } } },
  { id: 'D2', name: 'Paired, low exposure', testIds: ['TST-GS-D1', 'TST-GS-D3'], draftFixture: true,
    answers: { ...BASE, Q11B: 'none', Q17: '0' },
    expected: { status: 'scored', categories: cats('20.0', '15.0', '15.0', '12.5', '10.0', '10.0', '15.0'), hgiDisplay: '97.5', band: 'Minimal Gap',
      findings: [['HGA-C4Q1', 6]], strengths: ALL_STRENGTHS } },
  { id: 'E', name: 'Safety despite favorable HGI', testIds: ['TST-GS-E1', 'TST-GS-E2', 'TST-GS-E3', 'TST-GS-E4'], draftFixture: true,
    answers: { ...BASE, Q32: '1', Q32A: ['dizziness'], Q32B: 'no' },
    expected: { status: 'scored', categories: cats('20.0', '15.0', '15.0', '15.0', '10.0', '9.0', '15.0'), hgiDisplay: '99.0', band: 'Minimal Gap',
      findings: [['HGA-X05', 1]], strengths: ALL_STRENGTHS, pathways: { 'HGA-X05': 'E' } } },
  { id: 'F', name: 'Education need', testIds: ['TST-GS-F1', 'TST-GS-F2', 'TST-GS-F3', 'TST-GS-F4'], draftFixture: false,
    answers: { ...BASE, ...set(C5, '0') },
    expected: { status: 'scored', categories: cats('20.0', '15.0', '15.0', '15.0', '0.0', '10.0', '15.0'), hgiDisplay: '90.0', band: 'Minimal Gap',
      findings: [['HGA-C5', 6]], strengths: ['C1', 'C2', 'C3', 'C4', 'C6', 'C8'], pathways: { 'HGA-C5': 'A' } } },
  { id: 'G', name: 'Self-monitoring gap', testIds: ['TST-GS-G1', 'TST-GS-G2', 'TST-GS-G3'], draftFixture: false,
    answers: { ...BASE, ...set(C8, '0') },
    expected: { status: 'scored', categories: cats('20.0', '15.0', '15.0', '15.0', '10.0', '10.0', '0.0'), hgiDisplay: '85.0', band: 'Mild Gap',
      findings: [['HGA-X04', 5], ['HGA-C8', 6]], strengths: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'], pathways: { 'HGA-X04': 'B', 'HGA-C8': 'B' } } },
  { id: 'H', name: 'Multiple gaps / priority ordering', testIds: ['TST-GS-H1', 'TST-GS-H2', 'TST-GS-H3'], draftFixture: true,
    answers: { ...BASE, ...set(C1, '1'), ...set(C2, '0'), Q11B: '10+', Q13: '0', Q17: '0', Q32: '0', Q32A: ['faint'], Q32B: 'no' },
    expected: { status: 'scored', categories: cats('5.0', '0.0', '12.0', '12.5', '10.0', '8.0', '15.0'), hgiDisplay: '62.5', band: 'Moderate Gap',
      findings: [['HGA-X05', 1], ['HGA-C6', 1], ['HGA-X02', 2], ['HGA-C2', 2], ['HGA-X06', 3], ['HGA-C4Q1', 3], ['HGA-X03', 5], ['HGA-C1', 6]],
      strengths: ['C3', 'C4', 'C5', 'C6', 'C8'],
      pathways: { 'HGA-X05': 'E', 'HGA-C6': 'E', 'HGA-X02': 'C', 'HGA-C2': 'C', 'HGA-X06': 'D', 'HGA-C4Q1': 'B', 'HGA-X03': 'B', 'HGA-C1': 'B' } } },
  { id: 'I1', name: 'C7 lowest', testIds: ['TST-GS-I1', 'TST-GS-I2', 'TST-GS-I4'], draftFixture: true,
    answers: { ...BASE, ...set(C7, '0') },
    expected: { status: 'scored', categories: cats('20.0', '15.0', '15.0', '15.0', '10.0', '10.0', '15.0'), hgiDisplay: '100.0', band: 'Minimal Gap',
      findings: [['HGA-C7', 6]], strengths: ALL_STRENGTHS, pathways: { 'HGA-C7': 'C' } } },
  { id: 'I2', name: 'C7 not answered', testIds: ['TST-GS-I1', 'TST-GS-I3'], draftFixture: true,
    answers: { ...BASE, ...set(C7, 'PNA') },
    expected: { status: 'scored', categories: cats('20.0', '15.0', '15.0', '15.0', '10.0', '10.0', '15.0'), hgiDisplay: '100.0', band: 'Minimal Gap',
      findings: [], strengths: ALL_STRENGTHS } },
  { id: 'J', name: 'Missing required response', testIds: ['TST-GS-J1', 'TST-GS-J2', 'TST-GS-J3'], draftFixture: true,
    answers: { ...BASE, Q6: null },
    expected: { status: 'incomplete', missing: ['Q6'] } },
];

// ---- Category 4 normalization (TST-C4-001 to 008) ----
export interface C4Case { id: string; answers: Partial<RawAnswers>; expected: { status: Expected['status']; internal?: string; display?: string } }
export const C4_CASES: C4Case[] = [
  { id: 'TST-C4-001', answers: { Q17: '3', Q18: '3', Q19: '3', Q20: '3', Q21: '3', Q22: '3' }, expected: { status: 'scored', internal: '15', display: '15.0' } },
  { id: 'TST-C4-002', answers: { Q17: '2', Q18: '2', Q19: '2', Q20: '2', Q21: 'NA', Q22: 'NA' }, expected: { status: 'scored', internal: '10', display: '10.0' } },
  { id: 'TST-C4-003', answers: { Q17: '2', Q18: '2', Q19: '1', Q20: 'NA', Q21: 'NA', Q22: 'NA' }, expected: { status: 'scored', internal: '8.333333333333333333333333333333333333333', display: '8.3' } },
  { id: 'TST-C4-004', answers: { Q17: '3', Q18: '3', Q19: 'NA', Q20: 'NA', Q21: 'NA', Q22: 'NA' }, expected: { status: 'insufficient_c4' } },
  { id: 'TST-C4-005', answers: { Q17: '3', Q18: 'NA', Q19: '3', Q20: '3', Q21: '3', Q22: '3' }, expected: { status: 'scored', internal: '15', display: '15.0' } },
  { id: 'TST-C4-006', answers: { Q17: '3', Q18: null, Q19: '3', Q20: '3', Q21: '3', Q22: '3' }, expected: { status: 'incomplete' } },
];

// ---- C3Q4 lower-of (TST-C3Q4-001 to 005) ----
export const C3Q4_CASES: { id: string; q15a: string; q15b: string; expected: number }[] = [
  { id: 'TST-C3Q4-001', q15a: '3', q15b: '1', expected: 1 },
  { id: 'TST-C3Q4-002', q15a: '1', q15b: '3', expected: 1 },
  { id: 'TST-C3Q4-003', q15a: '3', q15b: '3', expected: 3 },
  { id: 'TST-C3Q4-004', q15a: '0', q15b: '3', expected: 0 },
  { id: 'TST-C3Q4-005', q15a: '2', q15b: '2', expected: 2 },
];

// ---- HGI boundary and rounding (TST-HGI-001 to 011) ----
export const HGI_CASES: { id: string; internal: string; display: string; band: string }[] = [
  { id: 'TST-HGI-001', internal: '90.0', display: '90.0', band: 'Minimal Gap' },
  { id: 'TST-HGI-002', internal: '89.9', display: '89.9', band: 'Mild Gap' },
  { id: 'TST-HGI-003', internal: '75.0', display: '75.0', band: 'Mild Gap' },
  { id: 'TST-HGI-004', internal: '74.9', display: '74.9', band: 'Moderate Gap' },
  { id: 'TST-HGI-005', internal: '60.0', display: '60.0', band: 'Moderate Gap' },
  { id: 'TST-HGI-006', internal: '59.9', display: '59.9', band: 'Significant Gap' },
  { id: 'TST-HGI-007', internal: '40.0', display: '40.0', band: 'Significant Gap' },
  { id: 'TST-HGI-008', internal: '39.9', display: '39.9', band: 'Critical Gap' },
  { id: 'TST-HGI-010a', internal: '89.95', display: '90.0', band: 'Minimal Gap' },
  { id: 'TST-HGI-010b', internal: '89.94', display: '89.9', band: 'Mild Gap' },
  { id: 'TST-HGI-011', internal: '74.95', display: '75.0', band: 'Mild Gap' },
];
