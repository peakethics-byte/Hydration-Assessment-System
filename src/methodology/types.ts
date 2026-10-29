// Shapes of the methodology content stored in rule_version.content.
// The engine reads these at run time; methodology never lives in engine code.

export type OptionKind = 'value' | 'na' | 'prefer_not' | 'none_of_these';

export interface ItemOption {
  code: string;
  label: string;
  /** Hidden point value. null for unscored items and for N/A / Prefer not to answer. */
  points: number | null;
  kind: OptionKind;
}

export type ItemType = 'scored' | 'component' | 'context' | 'contextual';

export interface AssessmentItem {
  itemCode: string; // question number, e.g. "Q15A"
  construct: string; // e.g. "C3Q4A", "EXP2"
  part: number;
  category: string; // C1..C8 or EXP
  type: ItemType;
  required: boolean;
  naAllowed: boolean;
  optional: boolean; // C7: may be skipped or answered Prefer not to answer
  multiSelect: boolean;
  prompt: string;
  options: ItemOption[];
}

export interface AssessmentContent {
  title: string;
  introduction: string;
  parts: { part: number; title: string; note?: string }[];
  items: AssessmentItem[];
  closingStatement: string;
}

export type CategoryMethod =
  | { kind: 'sum'; items: string[] }
  | { kind: 'sum_with_lower_of'; items: string[]; lowerOf: { construct: string; items: [string, string] } }
  | { kind: 'normalized'; items: string[]; perItemMax: number; minApplicable: number }
  | { kind: 'scaled'; items: string[]; rawMax: number }
  | { kind: 'contextual'; items: string[] };

export interface CategoryDef {
  code: string;
  name: string;
  max: number; // HGI points (0 for C7)
  method: CategoryMethod;
}

export interface ScoringContent {
  categories: CategoryDef[];
  hgiCategories: string[];
  rounding: { places: number; mode: 'half_up' };
  /** Bands checked top-down against the displayed value. */
  bands: { min: number; label: string }[];
  statusLabels: { incomplete: string; insufficientC4: string; scored: string };
}

// ---- HGA ----
export type Condition =
  | { type: 'itemLow'; item: string }
  | { type: 'itemHigh'; item: string }
  | { type: 'catLow'; cat: string }
  | { type: 'catHigh'; cat: string }
  | { type: 'optionIn'; item: string; codes: string[] }
  | { type: 'anySelected'; item: string; exclude: string[] }
  | { type: 'anyItemOption'; items: string[]; codes: string[] }
  | { type: 'institutionFlag'; flag: 'heatSafetyProcedures'; equals: string }
  | { type: 'notFired'; rules: string[] };

export type FindingLevel = 'cross' | 'category' | 'item';

export type SourceClass =
  | 'Athlete Behavior'
  | 'Institutional/Environmental'
  | 'Shared Athlete + Institution'
  | 'Safety/Appropriate Professional Follow-Up'
  | 'Shared / Contextual';

export interface HgaRule {
  id: string;
  level: FindingLevel;
  title: string;
  source: SourceClass;
  priority: number;
  /** Priority override when another rule also fired (e.g. HGA-C4Q1 -> 3 when HGA-X06 fires). */
  priorityWhenFired?: { rule: string; priority: number }[];
  isSafety: boolean;
  /** Category used for tie-break ordering (the "low" side for cross rules). */
  tieBreakCategory: string;
  /** Priority class when the same finding was present at the previous comparable assessment
   *  ("Persistent / repeated behavioral gaps", class 4, from the second assessment onward). */
  priorityWhenPersistent?: number;
  /** Follow-up items the rule needs; if any is blank the rule is "Not evaluable". */
  followUps?: string[];
  when: Condition[];
}

export interface HgaContent {
  thresholds: {
    lowItemMaxPoints: number;
    highItemMinPoints: number;
    lowCategoryMaxPct: number;
    strongCategoryMinPct: number;
  };
  levelOrder: FindingLevel[];
  rules: HgaRule[];
  strengths: { categories: string[]; minPct: number };
  priorityClasses: { class: number; description: string }[];
  /** Improvement amount for Improved / Worsened / Persistent (Milestone 3 Section 5.4, DRAFT). */
  change?: { categoryPctPoints: number; itemLevels: number };
}

// ---- IHS / Recommendation ----
export type Pathway = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type Audience = 'athlete' | 'institution' | 'health_support';

export interface PathwayMapping {
  rule: string;
  primary: Pathway;
  alsoAvailable: Pathway[];
  audience: Audience;
  reassessmentTarget: string;
}

export interface LibraryEntry {
  entryId: string;
  rule: string;
  pathway: Pathway;
  athleteText: string;
  staffText: string;
  institutionText: string;
  safetyRestrictions: string;
  isPlaceholder: boolean;
}

export interface RecommendationContent {
  pathways: { code: Pathway; name: string; enabled: boolean; usedWhen: string }[];
  mapping: PathwayMapping[];
  library: LibraryEntry[];
}
