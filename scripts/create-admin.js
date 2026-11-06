// Creates the first admin, or resets the password of the existing one
// (brainstorm section 7, admin recovery). Run it with `make admin`, on the Pi.
//
//   make admin                       prompts for the password
//   node scripts/create-admin.js --username=yucel
//
// Every run writes an audit entry (never the password) and, on a reset, ends
// every session of that admin. For scripted use with no terminal, the password
// is read from the first line of standard input.

import readline from 'node:readline/promises';
import { loadEnvFile, loadConfig } from '../app/config.js';
import { createPool } from '../app/db.js';
import { recordAudit } from '../app/services/audit.js';
import { USERNAME_PATTERN, createOrReset, listAdmins, normalizeUsername } from '../app/services/admins.js';
import { hashPassword, passwordProblems } from '../app/services/passwords.js';

const DEFAULT_USERNAME = 'admin';
const MAX_TRIES = 3;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Reads a line without echoing it.
function askHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          done();
          return resolve(value);
        }
        if (ch === '\u0003') {
          done();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdinLine() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/)[0] ?? '';
}

async function chooseUsername(existing) {
  const arg = process.argv.find((a) => a.startsWith('--username='));
  if (arg) {
    const name = normalizeUsername(arg.slice('--username='.length));
    if (!USERNAME_PATTERN.test(name)) fail('The user name must be 3 to 64 characters: letters, digits, dot, dash or underscore.');
    if (existing.length > 0 && !existing.some((a) => a.username === name)) {
      fail(`This wiki has a single admin ("${existing[0].username}"). Run without --username to reset that account.`);
    }
    return name;
  }
  if (existing.length === 1) return existing[0].username;
  if (existing.length > 1) fail('There is more than one admin. Pass --username=<name> to choose which one to reset.');
  if (!process.stdin.isTTY) return DEFAULT_USERNAME;

  for (let i = 0; i < MAX_TRIES; i++) {
    const name = normalizeUsername((await ask(`Admin user name [${DEFAULT_USERNAME}]: `)) || DEFAULT_USERNAME);
    if (USERNAME_PATTERN.test(name)) return name;
    console.error('Use 3 to 64 characters: letters, digits, dot, dash or underscore.');
  }
  return fail('No valid user name given.');
}

async function choosePassword(username, minLength) {
  if (!process.stdin.isTTY) {
    const password = await readStdinLine();
    const problems = passwordProblems(password, { minLength, username });
    if (problems.length > 0) fail(`That password is not acceptable:\n  - ${problems.join('\n  - ')}`);
    return password;
  }

  for (let i = 0; i < MAX_TRIES; i++) {
    const password = await askHidden(`New password (at least ${minLength} characters): `);
    const problems = passwordProblems(password, { minLength, username });
    if (problems.length > 0) {
      console.error(`Refused:\n  - ${problems.join('\n  - ')}\n`);
      continue;
    }
    if (password !== (await askHidden('Repeat the password: '))) {
      console.error('The two entries differ.\n');
      continue;
    }
    return password;
  }
  return fail('Too many attempts. Nothing was changed.');
}

const { envPath, found } = loadEnvFile();
const result = loadConfig();
if (!result.ok) {
  fail(`Cannot read the configuration. Fix these values in ${envPath}${found ? '' : ' (file not found)'}:\n  - ${result.errors.join('\n  - ')}`);
}
const { config } = result;
const pool = createPool(config.db);

try {
  let existing;
  try {
    existing = await listAdmins(pool);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') fail('The database is behind: admin_users does not exist. Run `make migrate` first.');
    fail(`Cannot reach the database (${err.code ?? err.message}). Is MariaDB running and are the .env credentials right?`);
  }

  const username = await chooseUsername(existing);
  console.log(
    existing.some((a) => a.username === username)
      ? `Resetting the password for "${username}". All its sessions will end.`
      : `Creating the admin "${username}".`,
  );
  const password = await choosePassword(username, config.session.passwordMinLength);

  const { id, created } = await createOrReset(pool, username, await hashPassword(password));
  const recorded = await recordAudit(pool, {
    actor: 'script',
    action: created ? 'admin.create' : 'admin.password_reset',
    targetType: 'admin',
    targetId: id,
    summary: `${created ? 'Admin created' : 'Password reset'} for "${username}" by scripts/create-admin.js.`,
  });

  console.log(created ? `\nAdmin "${username}" created.` : `\nPassword for "${username}" reset.`);
  if (!recorded) console.warn('Warning: the audit entry could not be written. See the error above.');
  console.log('You can now log in at /admin/login.\n');
} finally {
  await pool.end();
}
