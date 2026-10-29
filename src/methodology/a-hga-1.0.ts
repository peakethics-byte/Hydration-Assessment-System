// A-HGA-1.0 - HGA rules from Document #3 and Milestone 3 Section 3.
// DRAFT - trigger values, category/item finding triggers and the tie-break are awaiting WeCanH2O approval
// (Milestone 3 Section 6.7). This rule version is stored as a test fixture ("Fixture - not methodology")
// and cannot be activated in production until approved.
import type { Condition, HgaContent } from './types';

const qualifyingC6Event: Condition[] = [
  { type: 'optionIn', item: 'Q32', codes: ['0', '1'] }, // Often or Sometimes
  { type: 'anySelected', item: 'Q32A', exclude: ['none'] }, // at least one symptom selected
];

export const A_HGA_1_0: HgaContent = {
  thresholds: {
    lowItemMaxPoints: 1, // Low item: item score 0 or 1
    highItemMinPoints: 2, // High / strong item (Q16): Somewhat likely or Very likely
    lowCategoryMaxPct: 50, // Low category: 50% or lower
    strongCategoryMinPct: 80, // High / strong category: 80% or higher
  },
  levelOrder: ['cross', 'category', 'item'],
  rules: [
    // ---- Cross-category rules (Document #3 HGA-X01 to X06) ----
    { id: 'HGA-X01', level: 'cross', tieBreakCategory: 'C3', isSafety: false,
      title: 'Opportunity exists but use during prolonged/intense activity is weak (behavior/implementation opportunity)',
      source: 'Athlete Behavior', priority: 5,
      when: [{ type: 'itemLow', item: 'Q13' }, { type: 'catHigh', cat: 'C2' }] },
    { id: 'HGA-X02', level: 'cross', tieBreakCategory: 'C2', isSafety: false,
      title: 'Access/environment contributes; not attributed to athlete behavior alone',
      source: 'Shared Athlete + Institution', priority: 2,
      when: [{ type: 'itemLow', item: 'Q13' }, { type: 'catLow', cat: 'C2' }] },
    { id: 'HGA-X03', level: 'cross', tieBreakCategory: 'C1', isSafety: false,
      title: 'Knowledge-to-Action Gap',
      source: 'Athlete Behavior', priority: 5,
      when: [{ type: 'catHigh', cat: 'C5' }, { type: 'catLow', cat: 'C1' }] },
    { id: 'HGA-X04', level: 'cross', tieBreakCategory: 'C8', isSafety: false,
      title: 'Understanding stronger than self-monitoring / adaptive learning',
      source: 'Athlete Behavior', priority: 5,
      when: [{ type: 'catHigh', cat: 'C5' }, { type: 'catLow', cat: 'C8' }] },
    { id: 'HGA-X05', level: 'cross', tieBreakCategory: 'C6', isSafety: true,
      title: 'Safety Intention-to-Action Discrepancy - elevate for approved safety/support follow-up',
      source: 'Safety/Appropriate Professional Follow-Up', priority: 1,
      followUps: ['Q32A', 'Q32B'],
      when: [{ type: 'itemHigh', item: 'Q16' }, ...qualifyingC6Event, { type: 'optionIn', item: 'Q32B', codes: ['no'] }] },
    { id: 'HGA-X06', level: 'cross', tieBreakCategory: 'C4', isSafety: false,
      title: 'High exposure with weak adaptation - elevated interpretive priority; exposure never changes HGI',
      source: 'Shared / Contextual', priority: 3,
      when: [{ type: 'optionIn', item: 'Q11B', codes: ['6-9', '10+'] }, { type: 'itemLow', item: 'Q17' }] },

    // ---- Category-level findings (Milestone 3 Section 3.5, DRAFT) ----
    { id: 'HGA-C1', level: 'category', priorityWhenPersistent: 4, tieBreakCategory: 'C1', isSafety: false,
      title: 'Daily / circadian hydration routine gap', source: 'Athlete Behavior', priority: 6,
      when: [{ type: 'catLow', cat: 'C1' }] },
    { id: 'HGA-C2', level: 'category', tieBreakCategory: 'C2', isSafety: false,
      title: 'Water access / environmental barrier', source: 'Institutional/Environmental', priority: 2,
      when: [{ type: 'catLow', cat: 'C2' }] },
    { id: 'HGA-C3', level: 'category', priorityWhenPersistent: 4, tieBreakCategory: 'C3', isSafety: false,
      title: 'Exertion hydration management gap', source: 'Athlete Behavior', priority: 6,
      when: [{ type: 'catLow', cat: 'C3' }] },
    { id: 'HGA-C4', level: 'category', priorityWhenPersistent: 4, tieBreakCategory: 'C4', isSafety: false,
      title: 'Weak adaptation to hydration stressors', source: 'Athlete Behavior', priority: 6,
      when: [{ type: 'catLow', cat: 'C4' }] },
    { id: 'HGA-C5', level: 'category', tieBreakCategory: 'C5', isSafety: false,
      title: 'Knowledge / understanding need', source: 'Athlete Behavior', priority: 6,
      when: [{ type: 'catLow', cat: 'C5' }] },
    { id: 'HGA-C6', level: 'category', tieBreakCategory: 'C6', isSafety: true,
      title: 'Frequent self-reported symptom - professional review', source: 'Safety/Appropriate Professional Follow-Up', priority: 1,
      when: [{ type: 'anyItemOption', items: ['Q28', 'Q29', 'Q30', 'Q31', 'Q32'], codes: ['0'] }] },
    { id: 'HGA-C7', level: 'category', tieBreakCategory: 'C7', isSafety: false,
      title: 'Hair-care consideration affects activity or access (contextual; outside HGI)', source: 'Shared Athlete + Institution', priority: 6,
      when: [{ type: 'anyItemOption', items: ['Q33', 'Q34', 'Q35', 'Q36', 'Q37'], codes: ['0'] }] },
    { id: 'HGA-C8', level: 'category', priorityWhenPersistent: 4, tieBreakCategory: 'C8', isSafety: false,
      title: 'Self-monitoring / adaptive learning gap', source: 'Athlete Behavior', priority: 6,
      when: [{ type: 'catLow', cat: 'C8' }] },

    // ---- Institution procedure flag (TST-C3Q4-008) ----
    { id: 'HGA-INST-PROC', level: 'item', tieBreakCategory: 'C3', isSafety: false,
      title: 'Institutional procedure gap - no team hydration / heat-safety procedures recorded',
      source: 'Institutional/Environmental', priority: 2,
      when: [{ type: 'institutionFlag', flag: 'heatSafetyProcedures', equals: 'none' }] },

    // ---- Item-level findings (Milestone 3 Sections 3.4-3.5, DRAFT) ----
    { id: 'HGA-C3Q2', level: 'item', tieBreakCategory: 'C3', isSafety: false,
      title: 'Use of hydration opportunities during prolonged/intense activity is weak',
      source: 'Athlete Behavior', priority: 6,
      when: [{ type: 'itemLow', item: 'Q13' }, { type: 'notFired', rules: ['HGA-X01', 'HGA-X02'] }] },
    { id: 'HGA-C3Q4A', level: 'item', tieBreakCategory: 'C3', isSafety: false,
      title: 'Limited familiarity with team hydration / heat-safety procedures', source: 'Shared Athlete + Institution', priority: 2,
      when: [{ type: 'itemLow', item: 'Q15A' }, { type: 'notFired', rules: ['HGA-INST-PROC'] }] },
    { id: 'HGA-C3Q4B', level: 'item', priorityWhenPersistent: 4, tieBreakCategory: 'C3', isSafety: false,
      title: 'Procedures known but not consistently followed', source: 'Athlete Behavior', priority: 6,
      when: [{ type: 'itemLow', item: 'Q15B' }, { type: 'notFired', rules: ['HGA-INST-PROC'] }] },
    { id: 'HGA-C3Q5F', level: 'item', tieBreakCategory: 'C3', isSafety: false,
      title: 'Does not know whom to contact / what procedure to follow', source: 'Shared Athlete + Institution', priority: 2,
      followUps: ['Q16A'],
      when: [{ type: 'optionIn', item: 'Q16A', codes: ['no', 'not_sure'] }] },
    { id: 'HGA-C4Q1', level: 'item', tieBreakCategory: 'C4', isSafety: false,
      title: 'Weak heat / environment adaptation', source: 'Athlete Behavior', priority: 6,
      priorityWhenFired: [{ rule: 'HGA-X06', priority: 3 }],
      when: [{ type: 'itemLow', item: 'Q17' }] },
  ],
  strengths: { categories: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C8'], minPct: 80 },
  // DRAFT - Milestone 3 Section 5.4: at least 10 percentage points for category-based findings,
  // at least one response level for item-based findings.
  change: { categoryPctPoints: 10, itemLevels: 1 },
  priorityClasses: [
    { class: 1, description: 'Safety - specific safety/support findings, regardless of overall HGI' },
    { class: 2, description: 'Significant institutional / access barriers' },
    { class: 3, description: 'High exposure + weak adaptive behavior' },
    { class: 4, description: 'Persistent / repeated behavioral gaps (from the second assessment onward)' },
    { class: 5, description: 'Knowledge-to-action or intention-to-action discrepancies' },
    { class: 6, description: 'General education / improvement opportunities' },
  ],
};
