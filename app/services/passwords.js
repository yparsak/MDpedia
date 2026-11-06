// Password hashing with Node's built-in scrypt, so there is no native module to
// build on the Pi (brainstorm 5.11). Stored format:
//   scrypt$N$r$p$<salt base64>$<hash base64>
// The parameters are stored with the hash, so they can be raised later without
// breaking existing passwords.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { COMMON_PASSWORDS } from './common-passwords.js';

const scrypt = promisify(crypto.scrypt);

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// scrypt cost grows with input size, so an absurdly long "password" is refused
// rather than hashed.
export const MAX_PASSWORD_LENGTH = 256;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

// Returns true or false and never throws on a malformed stored hash.
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  try {
    const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// A hash of a random password nobody knows. Logging in as an unknown user
// verifies against this, so the response time does not reveal which user names exist.
let dummyHash;
export async function verifyAgainstDummy(password) {
  dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, dummyHash);
  return false;
}

// Returns a list of problems in plain words; an empty list means acceptable.
// Length counts characters, not bytes. No complexity rules (brainstorm 5.11).
export function passwordProblems(password, { minLength, username } = {}) {
  const problems = [];
  const length = Array.from(password).length;
  const lower = password.toLowerCase();

  if (length < minLength) problems.push(`Use at least ${minLength} characters (this has ${length}).`);
  if (length > MAX_PASSWORD_LENGTH) problems.push(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
  if (length > 0 && new Set(Array.from(password)).size === 1) problems.push('Do not repeat a single character.');
  if (COMMON_PASSWORDS.has(lower)) problems.push('That password is on the list of common passwords.');
  if (username && lower === String(username).toLowerCase()) problems.push('The password must not be the user name.');
  return problems;
}
