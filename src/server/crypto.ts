import crypto from 'node:crypto';

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n) });
  return crypto.timingSafeEqual(expected, actual);
}

/** Password rule for the MVP: at least 10 characters with a letter and a number. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Use at least one letter and one number.';
  return null;
}

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pepper(): string {
  const p = process.env.IDENTITY_PEPPER;
  if (p) return p;
  if (process.env.NODE_ENV === 'production') throw new Error('IDENTITY_PEPPER must be set in production');
  return 'local-development-pepper-not-for-production';
}

/** Lower-case, trim, collapse spaces, remove accents, so "  O'Neil " and "o'neil" match. */
export function normalizeIdentity(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Keyed hash for identity fields. The plain value is never stored. */
export function identityHash(value: string): string {
  return crypto.createHmac('sha256', pepper()).update(normalizeIdentity(value)).digest('hex');
}

/** Reassessment matching key: name + date of birth + mother's maiden name (client decision, Oct 16 2026). */
export function identityMatchHash(firstName: string, lastName: string, dateOfBirth: string, mothersMaidenName: string): string {
  return identityHash([firstName, lastName, dateOfBirth, mothersMaidenName].map(normalizeIdentity).join('|'));
}
