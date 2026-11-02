import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/src/server/db';
import { currentUser } from '@/src/server/session';
import { dashboard, recordExport, reportCsv } from '@/src/server/reporting';
import { PermissionError } from '@/src/server/roster';

// Structured CSV of the dashboard figures, with the same privacy suppression as the screen (REP-037, PRV-203).
export async function GET(req: NextRequest) {
  const u = await currentUser();
  if (!u) return NextResponse.redirect(new URL('/login', req.url));
  const q = req.nextUrl.searchParams;
  const tenantId = q.get('tenant') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return new NextResponse('Choose an institution first.', { status: 400 });
  const type = (q.get('type') ?? undefined) as 'all' | 'baseline' | 'reassessment' | undefined;
  const input = { periodId: q.get('period') ?? undefined, teamId: q.get('team') ?? undefined, type, version: q.get('version') ?? undefined };
  try {
    const db = await getDb();
    await recordExport(db, u.userId, { tenantId, format: 'CSV', context: { kind: 'dashboard', ...input } });
    const { data } = await dashboard(db, u.userId, tenantId, input);
    const name = `hydration-dashboard-${data.period.type}-${data.period.start}.csv`.toLowerCase();
    return new NextResponse(`﻿${reportCsv(data)}`, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
    });
  } catch (e) {
    if (e instanceof PermissionError) return new NextResponse(e.message, { status: 403 });
    throw e;
  }
}
