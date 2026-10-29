// Rule & Version Registry (F12). Loads methodology content from rule_version rows.
import type { Tx } from './db';
import type { AssessmentContent, HgaContent, RecommendationContent, ScoringContent } from '../methodology/types';
import { A_ASM_1_0 } from '../methodology/a-asm-1.0';
import { A_SCR_1_0 } from '../methodology/a-scr-1.0';
import { A_HGA_1_0 } from '../methodology/a-hga-1.0';
import { A_REC_1_0 } from '../methodology/a-rec-1.0';

export interface RuleSet {
  asmId: string;
  scrId: string;
  hgaId: string;
  recId: string;
  asm: AssessmentContent;
  scoring: ScoringContent;
  hga: HgaContent;
  rec: RecommendationContent;
}

/** Installs the College Athlete v1.0 rule versions (idempotent). */
export async function installCollegeAthleteRules(tx: Tx, environment: 'development' | 'staging' | 'production') {
  const versions = [
    { id: 'A-ASM-1.0', family: 'ASM', content: A_ASM_1_0, fixture: false, status: 'Approved' },
    { id: 'A-SCR-1.0', family: 'SCR', content: A_SCR_1_0, fixture: false, status: 'Approved' },
    // Draft trigger values: test fixture only until WeCanH2O approves (Milestone 3 Section 6.7).
    { id: 'A-HGA-1.0', family: 'HGA', content: A_HGA_1_0, fixture: true, status: 'Draft' },
    { id: 'A-REC-1.0', family: 'REC', content: A_REC_1_0, fixture: true, status: 'Draft' },
  ];
  for (const v of versions) {
    // Fixtures run in Development and Test/Staging only; they can never become Active in production.
    const status = v.fixture && environment === 'production' ? 'Draft' : environment === 'production' ? v.status : 'Active';
    await tx.query(
      `insert into rule_version (rule_version_id, population_code, family, version_label, status, is_fixture, content, effective_from, approved_by, approved_at)
       values ($1, 'A', $2, '1.0', $3, $4, $5, current_date, $6::text, case when $6::text is null then null else now() end)
       on conflict (rule_version_id) do nothing`,
      [v.id, v.family, status, v.fixture, JSON.stringify(v.content), v.fixture ? null : 'Governing Documents #1 and #2 v1.0'],
    );
  }
  for (const [i, item] of A_ASM_1_0.items.entries()) {
    await tx.query(
      `insert into assessment_item (asm_version_id, item_code, construct, part, category, item_type, is_scored, required, na_allowed, optional, multi_select, prompt, options, display_order)
       values ('A-ASM-1.0', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict do nothing`,
      [item.itemCode, item.construct, item.part, item.category, item.type, item.type === 'scored' || item.type === 'component',
        item.required, item.naAllowed, item.optional, item.multiSelect, item.prompt, JSON.stringify(item.options), i + 1],
    );
  }
  for (const e of A_REC_1_0.library) {
    await tx.query(
      `insert into rec_library_entry (entry_id, rec_version_id, finding_rule_id, pathway, athlete_text, staff_text, institution_text, safety_restrictions, is_placeholder)
       values ($1, 'A-REC-1.0', $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
      [e.entryId, e.rule, e.pathway, e.athleteText, e.staffText, e.institutionText, e.safetyRestrictions, e.isPlaceholder],
    );
  }
}

/** Active rule versions for a population. Every new assessment stores these IDs permanently. */
export async function activeRuleIds(tx: Tx, population: string) {
  const rows = (await tx.query<{ family: string; rule_version_id: string }>(
    `select family, rule_version_id from rule_version where population_code = $1 and status = 'Active'`, [population],
  )).rows;
  const pick = (f: string) => {
    const r = rows.filter((x) => x.family === f);
    if (r.length !== 1) throw new Error(`Expected exactly one Active ${f} rule version for population ${population}, found ${r.length}`);
    return r[0].rule_version_id;
  };
  return { asmId: pick('ASM'), scrId: pick('SCR'), hgaId: pick('HGA'), recId: pick('REC') };
}

/** Loads the exact versions stored on an instance (re-running an old record reproduces the original result). */
export async function loadRuleSet(tx: Tx, ids: { asmId: string; scrId: string; hgaId: string; recId: string }): Promise<RuleSet> {
  const rows = (await tx.query<{ rule_version_id: string; content: unknown }>(
    'select rule_version_id, content from rule_version where rule_version_id = any($1)',
    [[ids.asmId, ids.scrId, ids.hgaId, ids.recId]],
  )).rows;
  const get = <T>(id: string) => {
    const r = rows.find((x) => x.rule_version_id === id);
    if (!r) throw new Error(`Rule version ${id} not found`);
    return r.content as T;
  };
  return {
    ...ids,
    asm: get<AssessmentContent>(ids.asmId),
    scoring: get<ScoringContent>(ids.scrId),
    hga: get<HgaContent>(ids.hgaId),
    rec: get<RecommendationContent>(ids.recId),
  };
}
