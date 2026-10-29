import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getDb } from '@/src/server/db';
import { logout } from '@/src/server/auth';
import { SESSION_COOKIE } from '@/src/server/session';

export async function GET(req: Request) {
  const jar = await cookies();
  await logout(await getDb(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/login', req.url));
}
