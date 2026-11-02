import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/src/server/db';
import { currentUser } from '@/src/server/session';
import { getReport, recordExport } from '@/src/server/reporting';
import { renderReportPdf } from '@/src/server/report-pdf';
import { PermissionError } from '@/src/server/roster';

// Formal PDF (REP-036). Downloading is an export: it needs the export right and is logged (AUD-203).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.redirect(new URL('/login', req.url));
  const { id } = await params;
  const db = await getDb();
  const r = await getReport(db, u.userId, id);
  if (!r) return new NextResponse('Report not found.', { status: 404 });
  try {
    await recordExport(db, u.userId, { tenantId: r.tenant_id, format: 'PDF', context: { kind: 'formal_report', reportId: id, reportNumber: r.report_number, version: r.version, status: r.status } });
  } catch (e) {
    if (e instanceof PermissionError) return new NextResponse(e.message, { status: 403 });
    throw e;
  }
  const pdf = await renderReportPdf(r);
  const name = `${r.report_number}-v${r.version}${r.status === 'Released' ? '' : `-${r.status.replace(/\s+/g, '-')}`}.pdf`.toLowerCase();
  return new NextResponse(new Uint8Array(pdf), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
  });
}
