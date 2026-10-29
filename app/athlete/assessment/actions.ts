'use server';
// Server actions for the client-side stepper. Same services as before: saving and submitting still
// run on the server with the athlete's identity, validation and the database lock.
import { getDb } from '@/src/server/db';
import { saveDraft, submitAssessment } from '@/src/server/assessment';
import { athleteForm } from '@/src/server/athlete-form';
import { requireUser } from '@/src/server/session';

export type Answers = Record<string, string | string[] | undefined>;

export async function savePartAction(instanceId: string, codes: string[], values: Answers) {
  const u = await requireUser('athlete');
  try {
    const { errors } = await saveDraft(await getDb(), u.userId, instanceId, values, codes);
    return { ok: Object.keys(errors).length === 0, invalid: Object.keys(errors) };
  } catch (e) {
    return { ok: false, invalid: [] as string[], message: (e as Error).message };
  }
}

export async function submitAction(instanceId: string) {
  const u = await requireUser('athlete');
  const db = await getDb();
  try {
    const r = await submitAssessment(db, u.userId, instanceId);
    if (r.ok) return { ok: true as const };
    const { items } = await athleteForm(db, u.userId);
    const flagged = [...r.missingItems, ...r.invalidItems];
    const first = items.find((i) => flagged.includes(i.itemCode));
    // Insufficient Category 4 Data: nothing is blank, but fewer than 3 Part 4 answers apply.
    const message = flagged.length === 0
      ? `${r.statusLabel}. At least three questions in Part 4 must have an answer other than the "does not apply" choice.`
      : undefined;
    return { ok: false as const, flagged, firstPart: flagged.length ? first?.part ?? 1 : 4, missing: r.missingItems, message };
  } catch (e) {
    return { ok: false as const, flagged: [] as string[], firstPart: 1, missing: [] as string[], message: (e as Error).message };
  }
}
