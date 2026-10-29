import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { ackStatus } from '@/src/server/assessment';
import { athleteForm } from '@/src/server/athlete-form';
import { requireUser } from '@/src/server/session';
import Stepper from './Stepper';
import type { Answers } from './actions';

export default async function AssessmentPage({ searchParams }: { searchParams: Promise<{ part?: string; missing?: string }> }) {
  const u = await requireUser('athlete');
  const sp = await searchParams;
  const db = await getDb();
  const a = await ackStatus(db, u.userId);
  if (a.required && !a.acknowledged) redirect('/athlete'); // acknowledgment comes first when required
  const f = await athleteForm(db, u.userId);
  if (!['Not Started', 'In Progress'].includes(f.instance.status)) redirect('/athlete');

  // Saved answers as option codes only (hidden points never leave the server).
  const initialAnswers: Answers = Object.fromEntries(Object.entries(f.responses).map(([code, r]) =>
    [code, r.state === 'blank' ? undefined : r.optionCodes ?? r.optionCode]));

  return (
    <main className="narrow">
      <Stepper
        instanceId={f.instance.instance_id}
        title={f.title}
        introduction={f.introduction}
        parts={f.parts}
        items={f.items}
        initialAnswers={initialAnswers}
        initialPart={Math.min(Math.max(Number(sp.part) || 1, 1), f.parts.length)}
        initialFlagged={sp.missing?.split(',').filter(Boolean) ?? []}
      />
    </main>
  );
}
