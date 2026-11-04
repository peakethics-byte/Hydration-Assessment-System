// Formal PDF for quarterly and annual reports (REP-036). Every page carries the institution, the report
// period and the quarter (REP-017, TST-REP-002); reports that are not yet released are marked as drafts.
import PDFDocument from 'pdfkit';
import type { AnnualExtra, FormalReport, ReportData } from './reporting';
import { ANNUAL, NARRATIVE_FIELDS, fmtDate } from './reporting';
import type { Metric } from '../engine/aggregate';
import { ofTotal } from '../domain/format';

const NAVY = '#0B3B5C';
const AQUA = '#0891B2';
const GREY = '#5B6B78';
const LINE = '#C9D6DF';
const M = 54; // page margin

const fmt = (m: Metric) => ofTotal(m);

export function periodLabel(d: ReportData) {
  const q = d.period.type === 'Annual' ? 'Annual' : `Quarter ${d.period.type.slice(1)}`;
  return `${q} - ${fmtDate(d.period.start)} to ${fmtDate(d.period.end)}`;
}

export async function renderReportPdf(r: FormalReport, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const d = r.content.data;
  const annual = r.content.annual;
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 78, bottom: 66, left: M, right: M }, bufferPages: true, compress: opts.compress ?? true,
    info: { Title: `${r.report_type} - ${d.tenant.name} - ${periodLabel(d)}`, Author: 'WeCanH2O', Subject: r.report_number } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const W = doc.page.width - M * 2;

  const h1 = (t: string) => { ensure(60); doc.moveDown(0.6).font('Helvetica-Bold').fontSize(15).fillColor(NAVY).text(t); doc.moveDown(0.3); };
  const h2 = (t: string) => { ensure(40); doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11.5).fillColor(AQUA).text(t); doc.moveDown(0.15); };
  const para = (t: string, o: { grey?: boolean; italic?: boolean } = {}) =>
    doc.font(o.italic ? 'Helvetica-Oblique' : 'Helvetica').fontSize(10).fillColor(o.grey ? GREY : '#1F2A33').text(t, { width: W, lineGap: 2 }).moveDown(0.3);
  function ensure(h: number) { if (doc.y + h > doc.page.height - 72) doc.addPage(); }

  function table(head: string[], rows: string[][], widths: number[]) {
    const scale = W / widths.reduce((a, b) => a + b, 0);
    const ws = widths.map((w) => w * scale);
    const rowH = (cells: string[], bold = false) => Math.max(...cells.map((c, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).heightOfString(c, { width: ws[i] - 10 }))) + 10;
    const draw = (cells: string[], header: boolean) => {
      const h = rowH(cells, header);
      ensure(h + 2);
      const y = doc.y;
      if (header) doc.rect(M, y, W, h).fill(NAVY);
      let x = M;
      cells.forEach((c, i) => {
        doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(header ? '#FFFFFF' : '#1F2A33').text(c, x + 5, y + 5, { width: ws[i] - 10 });
        x += ws[i];
      });
      doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.x = M;
      doc.y = y + h;
    };
    draw(head, true);
    for (const row of rows) draw(row, false);
    doc.moveDown(0.5);
  }

  // ---- Title block
  doc.font('Helvetica-Bold').fontSize(10).fillColor(AQUA).text('Structured Hydration Assessment System');
  doc.moveDown(0.3).font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text(r.report_type);
  doc.moveDown(0.2).font('Helvetica').fontSize(12).fillColor(GREY).text(d.tenant.name);
  doc.moveDown(0.8);
  table(['Item', 'Value'], [
    ['Program Year', `${fmtDate(d.period.programYearStart)} to ${fmtDate(d.period.programYearEnd)}`],
    ['Report period', periodLabel(d)],
    ['Reporting Period Start Date', fmtDate(d.period.start)],
    ['Reporting Period End Date', fmtDate(d.period.end)],
    ['Report Generation Date', fmtDate(r.generated_at)],
    ['Report number / version', `${r.report_number} v${r.version}`],
    ['Status', r.status + (r.approved_at ? ` (approved ${fmtDate(r.approved_at)}${r.approved_by_name ? ` by ${r.approved_by_name}` : ''})` : '')],
    ['Assessment / rule versions', r.rule_versions.join(', ') || '-'],
    ['Privacy threshold', `Groups under ${r.suppression_threshold} athletes are withheld (${d.thresholdStatus})`],
  ], [1.3, 3]);
  if (r.correction_reason) para(`Corrected version. Reason: ${r.correction_reason}`, { italic: true });

  const n = r.narrative ?? {};
  if (r.report_type === ANNUAL && annual) annualBody(d, annual, n);
  else quarterlyBody(d, n);

  h2('Methodology / reporting notes');
  for (const note of d.notes) para(`- ${note}`, { grey: true });
  para('Figures describe observed patterns. They do not by themselves show that the program or any intervention caused a change.', { grey: true });

  // ---- Header and footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const top = doc.page.margins.top;
    const bottom = doc.page.margins.bottom;
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text(d.tenant.name, M, 32, { width: W / 2, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(GREY).text(periodLabel(d), M + W / 2, 32, { width: W / 2, align: 'right', lineBreak: false });
    doc.moveTo(M, 46).lineTo(M + W, 46).lineWidth(0.5).strokeColor(LINE).stroke();
    const status = r.status === 'Released' ? 'Released' : r.status === 'Superseded' ? 'SUPERSEDED - see the corrected version' : `${r.status.toUpperCase()} - NOT RELEASED`;
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
      .text(`${r.report_type} | ${r.report_number} v${r.version} | ${status}`, M, doc.page.height - 40, { width: W - 70, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, M + W - 70, doc.page.height - 40, { width: 70, align: 'right', lineBreak: false });
    if (r.status !== 'Released') {
      doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('Helvetica-Bold').fontSize(64).fillColor('#D97706').opacity(0.08)
        .text(r.status === 'Superseded' ? 'SUPERSEDED' : 'DRAFT', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false }).restore();
      doc.opacity(1);
    }
    doc.page.margins.top = top;
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;

  // ---------------------------------------------------------------- sections
  function snapshot(dd: ReportData) {
    const p = dd.participation;
    table(['Measure', 'Value'], [
      ['Participating teams', p.teams.join(', ') || '-'],
      ['Number eligible (team lists)', String(p.eligible)],
      ['Number assessed', String(p.assessed)],
      ['Baseline assessments', String(p.baseline)],
      ['Reassessments', String(p.reassessed)],
      ['Completion rate (assessed / eligible)', fmt(p.completion)],
      ['Assessment version(s)', p.versions.join(', ') || '-'],
    ], [2, 2]);
  }

  function hgi(dd: ReportData) {
    const s = dd.summary;
    if (s.suppressed) { para(`Withheld: fewer than ${dd.threshold} athletes were assessed.`, { italic: true }); return; }
    if (!s.assessed) { para('No valid assessments in this period.', { italic: true }); return; }
    para(`Full Assessment Population: ${s.assessed} athletes. Average HGI ${s.hgiMean}; median HGI ${s.hgiMedian}.`);
    table(['HGI band', 'Athletes'], s.bands.map((b) => [b.band, fmt(b.athletes)]), [2, 2]);
  }

  function gapAnalysis(dd: ReportData) {
    const s = dd.summary;
    if (s.suppressed || !s.assessed) { para('Withheld or no data.', { italic: true }); return; }
    table(['Category', 'Average category %', 'Note'], s.categories.map((c) => [`${c.code} ${c.name}`, c.contextual ? '-' : c.meanPct == null ? '-' : `${c.meanPct}%`,
      c.contextual ? 'Contextual - outside the HGI' : `${c.n} athletes`]), [3, 1.2, 1.6]);
    h2('Priority gaps');
    table(['Pattern', 'Athletes'], s.gaps.slice(0, 8).map((g) => [g.title + (g.isSafety ? ' (safety/support)' : ''), fmt(g.athletes)]), [3.6, 1.4]);
    h2('Strengths');
    table(['Strength', 'Athletes'], s.strengths.slice(0, 8).map((g) => [g.title.replace('Strength: ', ''), fmt(g.athletes)]), [3.6, 1.4]);
  }

  function institutional(dd: ReportData) {
    const s = dd.summary;
    if (s.suppressed || !s.assessed) { para('Withheld or no data.', { italic: true }); return; }
    const c2 = s.categories.find((c) => c.code === 'C2');
    para(`Category 2 (Water Access & Environmental Barriers) average: ${c2?.meanPct ?? '-'}%.`);
    table(['Institutional / access / environmental pattern', 'Athletes'],
      s.institutional.length ? s.institutional.map((g) => [g.title, fmt(g.athletes)]) : [['None identified', '-']], [3.6, 1.4]);
    para(`Team hydration / heat-safety procedures recorded: ${dd.procedures.exist} in place, ${dd.procedures.none} none, ${dd.procedures.unknown} not recorded.`);
  }

  function activity(dd: ReportData) {
    const i = dd.interventions;
    table(['Measure', 'Value'], [
      ['Approved results released to athletes', String(i.resultsReleased)],
      ['Hydration Action Items delivered', String(i.itemsDelivered)],
      ['Athletes with action items', String(i.athletesWithItems)],
      ['Action items completed / implemented', fmt(i.itemsCompleted)],
    ], [2.4, 1.6]);
  }

  function change(dd: ReportData) {
    const m = dd.matched;
    para(`Matched Cohort (athletes with a comparable baseline and reassessment): ${m.suppressed ? 'withheld (privacy)' : m.n}. `
      + `Full Assessment Population this period: ${dd.fullPopulation.assessed}. The two groups are reported separately.`);
    para(dd.changeText);
    if (!m.suppressed && m.n) {
      table(['Matched Cohort measure', 'Value'], [
        ['Average HGI at baseline', m.baselineMean ?? '-'], ['Average HGI at reassessment', m.currentMean ?? '-'], ['Average change', m.meanChange ?? '-'],
        ['HGI higher', fmt(m.higher)], ['HGI unchanged', fmt(m.same)], ['HGI lower', fmt(m.lower)],
        ...m.states.map((s) => [`Athletes with a ${s.state.toLowerCase()} gap`, fmt(s.athletes)]),
      ], [2.4, 1.6]);
    }
    const ra = dd.reassessment;
    table(['Reassessment windows ending this period', 'Value'], [
      ['Windows due', String(ra.due)], ['Completed', fmt(ra.completed)],
      ['Reassessment Not Completed / Outcome Unknown', fmt(ra.outcomeUnknown)], ['Still open', fmt(ra.stillOpen)],
    ], [2.4, 1.6]);
  }

  function safety(dd: ReportData) {
    const s = dd.summary.safety;
    para(s.suppressed
      ? (s.present ? `Safety / support indicators were present (fewer than ${dd.threshold} athletes; exact count withheld).` : 'Withheld (privacy).')
      : `Athletes with at least one safety / support indicator: ${fmt(s)}.`);
    para('Individual symptom details are never included in this report. They remain with authorized health-support staff.', { grey: true });
  }

  function prioritiesSection(dd: ReportData, note?: string) {
    if (!dd.priorities.length) para('No rules-based priority areas for this period.', { italic: true });
    else table(['Area', 'Priority', 'Basis'], dd.priorities.map((p) => [p.kind, p.title, p.detail]), [1.3, 2.2, 2]);
    if (note) { h2('Reviewer notes'); para(note); }
  }

  function teamsTable(dd: ReportData) {
    table([dd.labels.team, 'Assessed', 'Average HGI', 'Safety / support', 'Most common gap'], dd.teams.map((t) => [t.name, String(t.assessed),
      t.suppressed ? 'Withheld' : t.hgiMean ?? '-', t.suppressed ? (t.safety.present ? 'Present' : 'Withheld') : t.safety.present ? fmt(t.safety) : 'None',
      t.suppressed ? 'Withheld' : t.topGap ?? '-']), [1.4, 0.8, 0.9, 1.1, 2]);
  }

  function quarterlyBody(dd: ReportData, nn: Record<string, string>) {
    h1('1. Program Snapshot'); snapshot(dd);
    h1('2. HGI Overview'); hgi(dd);
    h2('Quarterly trend');
    table(['Quarter', 'Dates', 'Assessed', 'Average HGI'], dd.trend.map((t) => [t.period, `${fmtDate(t.start)} - ${fmtDate(t.end)}`, String(t.assessed), t.suppressed ? 'Withheld' : t.hgiMean ?? '-']), [0.7, 2.4, 0.8, 1]);
    h1('3. Hydration Gap Analysis'); gapAnalysis(dd);
    h1('4. Institutional / Environmental Findings'); institutional(dd);
    h1('5. Education & Intervention Activity'); activity(dd);
    h1('6. Reassessment & Change'); change(dd);
    h1('7. Safety & Support Indicators'); safety(dd);
    h1('8. Priority Opportunities'); prioritiesSection(dd, nn.priorityNotes);
    h2(`${dd.labels.team} comparison (where privacy permits)`); teamsTable(dd);
    h1('9. Recommended Next-Quarter Actions');
    para(nn.nextQuarterActions?.trim() || 'To be completed by the WeCanH2O reviewer.', { italic: !nn.nextQuarterActions });
  }

  function annualBody(dd: ReportData, a: AnnualExtra, nn: Record<string, string>) {
    const field = (k: string) => nn[k]?.trim() || `To be completed by the WeCanH2O reviewer (${NARRATIVE_FIELDS[ANNUAL].find((f) => f.key === k)?.label}).`;
    h1('Executive Summary'); para(field('executiveSummary'));
    h1('Program Scope and Participation'); snapshot(dd);
    h1('Baseline Hydration Intelligence Findings');
    if (a.baseline.suppressed) para('Withheld (privacy).', { italic: true });
    else {
      para(`Baseline assessments: ${a.baseline.assessed}. Average baseline HGI ${a.baseline.hgiMean ?? '-'}.`);
      table(['Most common baseline gaps', 'Athletes'], a.baseline.gaps.slice(0, 6).map((g) => [g.title, fmt(g.athletes)]), [3.6, 1.4]);
    }
    h1('Annual HGI and HGA Overview'); hgi(dd); gapAnalysis(dd);
    h1('Persistent, Resolved, Worsened, and Emerging Hydration Gaps');
    if (!a.gapStates.length) para('Not available: the Matched Cohort is empty or below the privacy threshold.', { italic: true });
    for (const g of a.gapStates) {
      h2(g.state === 'New' ? 'Emerging (new) gaps' : `${g.state} gaps`);
      table(['Pattern', 'Athletes in the Matched Cohort'], g.patterns.length ? g.patterns.map((p) => [p.title, fmt(p.athletes)]) : [['None', '-']], [3.6, 1.4]);
    }
    h1('Institutional / Environmental Findings'); institutional(dd);
    h1('Education, IHS, Hydration Action Items, and Other Interventions'); activity(dd);
    h1('Matched-Cohort Baseline-to-Year-End Change'); para(a.yearEndText); change(dd);
    h1(`${dd.labels.team} / Program Comparisons (where privacy permits)`); teamsTable(dd);
    h1('Outcome Dimensions');
    for (const [title, rows] of [['Athlete Hydration Intelligence outcomes', a.outcomes.athlete], ['Hydration Environment / institutional outcomes', a.outcomes.environment],
      ['Athletic Program Practices', a.outcomes.practices], ['Program Engagement / Delivery', a.outcomes.engagement]] as const) {
      h2(title);
      table(['Measure', 'Value'], rows.map((x) => [x.label, x.value]), [2.6, 1.4]);
    }
    h1('Persistent and Emerging Priorities'); prioritiesSection(dd);
    h1('Institutional Actions / Program Practice Developments'); para(field('institutionalActions'));
    h1('Next-Year Recommendations and Priorities'); para(field('nextYear'));
  }
}
