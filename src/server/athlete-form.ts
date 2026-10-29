// Athlete-facing view of the assessment. Hidden point values never leave the server.
import type { Db } from './db';
import { loadRuleSet } from './rules';
import { loadResponses, openAssessment } from './assessment';

export interface PublicOption { code: string; label: string }
export interface PublicItem { itemCode: string; part: number; prompt: string; multiSelect: boolean; optional: boolean; required: boolean; options: PublicOption[] }

export async function athleteForm(db: Db, userId: string) {
  const inst = await openAssessment(db, userId);
  return db.system(async (tx) => {
    const rules = await loadRuleSet(tx, { asmId: inst.asm_version_id, scrId: inst.scr_version_id, hgaId: inst.hga_version_id, recId: inst.rec_version_id });
    const responses = await loadResponses(tx, inst.instance_id);
    const lastValidation = (await tx.query<{ outcome: string; missing_items: string[] }>(
      'select outcome, missing_items from validation_result where instance_id = $1 order by checked_at desc limit 1', [inst.instance_id])).rows[0];
    const items: PublicItem[] = rules.asm.items.map((i) => ({
      itemCode: i.itemCode, part: i.part, prompt: i.prompt, multiSelect: i.multiSelect, optional: i.optional, required: i.required,
      options: i.options.map((o) => ({ code: o.code, label: o.label })),
    }));
    return {
      instance: inst,
      title: rules.asm.title,
      introduction: rules.asm.introduction,
      closingStatement: rules.asm.closingStatement,
      parts: rules.asm.parts,
      items,
      responses,
      lastValidation: lastValidation && lastValidation.outcome !== 'Passed' ? lastValidation : null,
    };
  });
}
