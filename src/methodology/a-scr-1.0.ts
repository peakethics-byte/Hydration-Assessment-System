// A-SCR-1.0 - Scoring rules from Document #1 and Milestone 3 Sections 1.5, 1.6 and 2.
import type { ScoringContent } from './types';

export const A_SCR_1_0: ScoringContent = {
  categories: [
    { code: 'C1', name: 'Lifestyle & Circadian Hydration Behavior', max: 20,
      method: { kind: 'sum', items: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] } },
    { code: 'C2', name: 'Water Access & Environmental Barriers', max: 15,
      method: { kind: 'sum', items: ['Q6', 'Q7', 'Q8', 'Q9', 'Q10'] } },
    { code: 'C3', name: 'Exertion & Hydration Management', max: 15,
      method: { kind: 'sum_with_lower_of', items: ['Q12', 'Q13', 'Q14', 'Q16'],
        lowerOf: { construct: 'C3Q4', items: ['Q15A', 'Q15B'] } } },
    { code: 'C4', name: 'Hydration Stressors & Adaptive Response', max: 15,
      method: { kind: 'normalized', items: ['Q17', 'Q18', 'Q19', 'Q20', 'Q21', 'Q22'], perItemMax: 3, minApplicable: 3 } },
    { code: 'C5', name: 'Hydration Knowledge & Decision-Making', max: 10,
      method: { kind: 'scaled', items: ['Q23', 'Q24', 'Q25', 'Q26', 'Q27'], rawMax: 15 } },
    { code: 'C6', name: 'Self-Reported Symptoms', max: 10,
      method: { kind: 'sum', items: ['Q28', 'Q29', 'Q30', 'Q31', 'Q32'] } },
    { code: 'C7', name: 'Hair Care, Physical Activity & Hydration Access', max: 0,
      method: { kind: 'contextual', items: ['Q33', 'Q34', 'Q35', 'Q36', 'Q37'] } },
    { code: 'C8', name: 'Hydration Self-Monitoring & Decision Behavior', max: 15,
      method: { kind: 'sum', items: ['Q38', 'Q39', 'Q40', 'Q41', 'Q42'] } },
  ],
  hgiCategories: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C8'],
  rounding: { places: 1, mode: 'half_up' },
  bands: [
    { min: 90, label: 'Minimal Gap' },
    { min: 75, label: 'Mild Gap' },
    { min: 60, label: 'Moderate Gap' },
    { min: 40, label: 'Significant Gap' },
    { min: 0, label: 'Critical Gap' },
  ],
  statusLabels: {
    incomplete: 'Assessment Incomplete - HGI Not Calculated',
    insufficientC4: 'Insufficient Category 4 Data',
    scored: 'Complete / Scored',
  },
};
