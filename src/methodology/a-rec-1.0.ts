// A-REC-1.0 - Response pathways and finding-to-pathway mapping (Document #3, Milestone 3 Section 4).
// DRAFT - mapping and reassessment targets await WeCanH2O approval.
// Recommendation Library wording is supplied by WeCanH2O (hand-off open item 5). Until it arrives every
// entry carries the placeholder text "WeCanH2O" and is flagged isPlaceholder.
import type { LibraryEntry, PathwayMapping, RecommendationContent } from './types';

const mapping: PathwayMapping[] = [
  { rule: 'HGA-X01', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'Q13 use of hydration opportunities during activity' },
  { rule: 'HGA-X02', primary: 'C', alsoAvailable: ['B'], audience: 'institution', reassessmentTarget: 'C2 access items and Q13' },
  { rule: 'HGA-X03', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'C1 routine items' },
  { rule: 'HGA-X04', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'C8 self-monitoring items' },
  { rule: 'HGA-X05', primary: 'E', alsoAvailable: ['A'], audience: 'health_support', reassessmentTarget: 'Q32B actual response; Q16A awareness' },
  { rule: 'HGA-X06', primary: 'D', alsoAvailable: ['B', 'C'], audience: 'athlete', reassessmentTarget: 'Q17 heat adaptation' },
  { rule: 'HGA-C1', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'C1 score and lowest C1 items' },
  { rule: 'HGA-C2', primary: 'C', alsoAvailable: [], audience: 'institution', reassessmentTarget: 'C2 score' },
  { rule: 'HGA-C3', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'C3 items' },
  { rule: 'HGA-C3Q2', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'Q13 use of hydration opportunities during activity' },
  { rule: 'HGA-C3Q4B', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'Q15B' },
  { rule: 'HGA-C3Q4A', primary: 'A', alsoAvailable: ['C'], audience: 'athlete', reassessmentTarget: 'Q15A' },
  { rule: 'HGA-C3Q5F', primary: 'A', alsoAvailable: ['C'], audience: 'athlete', reassessmentTarget: 'Q16A' },
  { rule: 'HGA-C4', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'C4 score' },
  { rule: 'HGA-C4Q1', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'Q17' },
  { rule: 'HGA-C5', primary: 'A', alsoAvailable: [], audience: 'athlete', reassessmentTarget: 'C5 score' },
  { rule: 'HGA-C6', primary: 'E', alsoAvailable: [], audience: 'health_support', reassessmentTarget: 'C6 items reported Often' },
  { rule: 'HGA-C8', primary: 'B', alsoAvailable: ['D'], audience: 'athlete', reassessmentTarget: 'C8 score' },
  { rule: 'HGA-C7', primary: 'C', alsoAvailable: ['D'], audience: 'institution', reassessmentTarget: 'C7 items (tracked outside HGI)' },
  { rule: 'HGA-INST-PROC', primary: 'C', alsoAvailable: [], audience: 'institution', reassessmentTarget: 'Institution procedure status; Q15A/Q15B' },
];

const PLACEHOLDER = 'WeCanH2O';

// One placeholder library entry per finding and each pathway available to it.
const library: LibraryEntry[] = mapping.flatMap((m) =>
  [m.primary, ...m.alsoAvailable].map((pathway) => ({
    entryId: `A-REC-1.0/${m.rule}/${pathway}`,
    rule: m.rule,
    pathway,
    athleteText: PLACEHOLDER,
    staffText: PLACEHOLDER,
    institutionText: PLACEHOLDER,
    safetyRestrictions: pathway === 'E' ? 'Follow the approved athletic-training / sports-medicine pathway. No diagnosis.' : '',
    isPlaceholder: true,
  })),
);

export const A_REC_1_0: RecommendationContent = {
  pathways: [
    { code: 'A', name: 'Education', enabled: true, usedWhen: 'Understanding or knowledge support is the primary need' },
    { code: 'B', name: 'Behavior & Routine', enabled: true, usedWhen: 'Implementation, timing, routine, planning or self-monitoring is the primary need' },
    { code: 'C', name: 'Institutional / Environmental', enabled: true, usedWhen: 'The institution, team, facility, schedule, access or procedure is a material contributor' },
    { code: 'D', name: 'Individualized Hydration Planning', enabled: true, usedWhen: 'A personal strategy should integrate the Hydration Profile and identified gaps' },
    { code: 'E', name: 'Safety / Professional Follow-Up', enabled: true, usedWhen: 'The finding should follow the approved athletic-training, sports-medicine or health-support pathway' },
    { code: 'F', name: 'Product / Functional Support Consideration', enabled: false, usedWhen: 'Disabled in A-REC-1.0. Never triggered automatically.' },
  ],
  mapping,
  library,
};
