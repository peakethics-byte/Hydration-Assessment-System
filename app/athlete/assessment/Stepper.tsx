'use client';
// Client-side stepper: moving between Parts happens in the browser (no page reload). Each move saves
// the Part through the server action first, so the server stays the authority for saving,
// validation and submission.
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PublicItem } from '@/src/server/athlete-form';
import { savePartAction, submitAction, type Answers } from './actions';

interface Part { part: number; title: string; note?: string }

export default function Stepper(props: {
  instanceId: string;
  title: string;
  introduction: string;
  parts: Part[];
  items: PublicItem[];
  initialAnswers: Answers;
  initialPart: number;
  initialFlagged: string[];
}) {
  const router = useRouter();
  const [part, setPart] = useState(props.initialPart);
  const [dir, setDir] = useState<'next' | 'back'>('next');
  const [answers, setAnswers] = useState<Answers>(props.initialAnswers);
  const [flagged, setFlagged] = useState<Set<string>>(new Set(props.initialFlagged));
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    props.initialFlagged.length ? { kind: 'error', text: missingText(props.initialFlagged) } : null);
  const [pending, start] = useTransition();
  const total = props.parts.length;
  const current = props.parts.find((p) => p.part === part)!;
  const items = useMemo(() => props.items.filter((i) => i.part === part), [props.items, part]);

  // Keep the address bar in step without reloading (refresh or bookmark opens the same Part).
  useEffect(() => { window.history.replaceState(null, '', `/athlete/assessment?part=${part}`); }, [part]);

  function setAnswer(code: string, value: string, multi: boolean, noneCode?: string) {
    setAnswers((prev) => {
      if (!multi) return { ...prev, [code]: value };
      const cur = new Set(Array.isArray(prev[code]) ? (prev[code] as string[]) : []);
      if (cur.has(value)) cur.delete(value);
      else {
        // "None of these" cannot be combined with symptoms (same rule the server checks).
        if (value === noneCode) cur.clear();
        else if (noneCode) cur.delete(noneCode);
        cur.add(value);
      }
      return { ...prev, [code]: [...cur] };
    });
    setFlagged((f) => { if (!f.has(code)) return f; const n = new Set(f); n.delete(code); return n; });
  }

  function partValues() {
    const codes = items.map((i) => i.itemCode);
    return { codes, values: Object.fromEntries(codes.map((c) => [c, answers[c]])) as Answers };
  }

  function go(action: 'prev' | 'next' | 'save' | 'submit', target?: number) {
    start(async () => {
      const { codes, values } = partValues();
      const saved = await savePartAction(props.instanceId, codes, values);
      if (!saved.ok) {
        setFlagged(new Set(saved.invalid));
        setNotice({ kind: 'error', text: saved.message ?? 'Please check the highlighted answers.' });
        return;
      }
      if (action === 'save') { setNotice({ kind: 'ok', text: 'Your answers are saved.' }); return; }
      if (action === 'submit') {
        const r = await submitAction(props.instanceId);
        if (r.ok) { router.push('/athlete/assessment/done'); return; }
        setFlagged(new Set(r.flagged));
        setNotice({ kind: 'error', text: r.message ?? missingText(r.missing) });
        move(r.firstPart);
        return;
      }
      setNotice(null);
      move(target ?? (action === 'next' ? part + 1 : part - 1));
    });
  }

  function move(to: number) {
    const next = Math.min(Math.max(to, 1), total);
    if (next === part) return;
    setDir(next > part ? 'next' : 'back');
    setPart(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <>
      <div className="eyebrow">{props.title}</div>
      <p className="muted">{props.introduction}</p>

      <div className="stepper">
        <div className="bar"><span style={{ width: `${(part / total) * 100}%` }} /></div>
        <div className="meta"><span>Part {part} of {total}</span><span>{current.title}</span></div>
        <nav className="steps" aria-label="Parts">
          {props.parts.map((p) => (
            <a key={p.part} href={`/athlete/assessment?part=${p.part}`} title={p.title}
              aria-current={p.part === part ? 'step' : undefined}
              className={p.part === part ? 'on' : p.part < part ? 'done' : ''}
              onClick={(e) => { e.preventDefault(); if (!pending && p.part !== part) go(p.part > part ? 'next' : 'prev', p.part); }}>
              {p.part}
            </a>
          ))}
        </nav>
      </div>

      {notice && <div className={`notice ${notice.kind}`} role="status">{notice.text}</div>}

      <div className="step-viewport">
        <form key={part} className={`card step-card ${dir === 'back' ? 'from-left' : 'from-right'}`}
          onSubmit={(e) => { e.preventDefault(); go(part === total ? 'submit' : 'next'); }}>
          <div className="part-head">
            <div className="eyebrow">Part {current.part}</div>
            <h2>{current.title}</h2>
            {current.note && <p className="muted small" style={{ marginTop: 10 }}>{current.note}</p>}
          </div>

          {items.map((item) => {
            const value = answers[item.itemCode];
            const selected = new Set(Array.isArray(value) ? value : value ? [value] : []);
            const noneCode = item.multiSelect ? item.options.find((o) => o.code === 'none')?.code : undefined;
            return (
              <fieldset key={item.itemCode} className={`question${flagged.has(item.itemCode) ? ' missing' : ''}`}>
                <legend className="prompt"><span className="qnum">{item.itemCode.replace(/^Q/, '')}</span><span>{item.prompt}</span></legend>
                {flagged.has(item.itemCode) && <p className="warn">Please answer this question.</p>}
                <div className="options">
                  {item.options.map((o) => (
                    <label className={`option${item.multiSelect ? ' multi' : ''}`} key={o.code}>
                      <input type={item.multiSelect ? 'checkbox' : 'radio'} name={item.itemCode} value={o.code}
                        checked={selected.has(o.code)}
                        onChange={() => setAnswer(item.itemCode, o.code, item.multiSelect, noneCode)} />
                      <span className="tick" aria-hidden="true" />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}

          <div className="form-actions">
            {part > 1
              ? <button type="button" className="secondary" disabled={pending} onClick={() => go('prev')}>&larr; Back</button>
              : <span />}
            <div className="right">
              <button type="button" className="secondary" disabled={pending} onClick={() => go('save')}>Save</button>
              {part < total
                ? <button type="submit" disabled={pending}>{pending ? 'Saving...' : <>Save and continue &rarr;</>}</button>
                : <button type="submit" disabled={pending}>{pending ? 'Submitting...' : 'Submit my assessment'}</button>}
            </div>
          </div>
        </form>
      </div>
      <p className="muted small">Your answers are saved each time you move between parts. You can finish later within 14 days.</p>
    </>
  );
}

function missingText(codes: string[]) {
  return `Some required questions are not answered yet, so the assessment was not submitted: ${codes.map((c) => c.replace(/^Q/, '')).join(', ')}.`;
}
