// A Windows-friendly local PostgreSQL launcher for development/tests when Docker isn't
// available — uses an embedded, portable PostgreSQL binary instead of a system service. On any
// other platform, use `docker compose up -d` instead (see docker-compose.yml at the repo root).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const action = process.argv[2] ?? 'up';
if (!['up', 'down', 'status'].includes(action)) throw new Error('Usage: local-postgres.mjs up|down|status');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This local launcher is for Windows x64. Use `docker compose up -d` on other platforms.');
}
const { initdb, pg_ctl } = await import('@embedded-postgres/windows-x64');
// LOCAL_POSTGRES_DIR relocates the cluster (initdb needs a POSIX-style filesystem such as NTFS, not exFAT).
const directory = process.env.LOCAL_POSTGRES_DIR ? resolve(process.env.LOCAL_POSTGRES_DIR) : join(root, 'data', '.postgres');
const cluster = join(directory, 'cluster');
const log = join(directory, 'postgres.log');
const run = (binary, args) => execFileSync(binary, args, { windowsHide: true, stdio: 'inherit' });
if (existsSync('.env')) process.loadEnvFile('.env');

// Windows process permissions can hide a server started outside the sandbox — verify the
// authenticated connection and cluster path instead of trusting a process id.
const running = async () => {
  if (!existsSync(join(cluster, 'PG_VERSION'))) return false;
  const client = new Client({ host: '127.0.0.1', port: Number(process.env.POSTGRES_PORT ?? '5432'),
    user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD,
    database: 'postgres', connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const result = await client.query('SHOW data_directory');
    if (resolve(result.rows[0].data_directory).toLowerCase() !== resolve(cluster).toLowerCase()) {
      throw new Error('Another database cluster is already running on this port; this launcher will not touch it.');
    }
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') return false;
    throw error;
  } finally { await client.end(); }
};

if (action === 'down') {
  if (await running()) run(pg_ctl, ['stop', '-D', cluster, '-m', 'fast', '-w']);
  else console.log('Local PostgreSQL server is already stopped.');
} else if (action === 'status') {
  console.log(await running() ? `PostgreSQL is running. Data: ${cluster}` : 'Local PostgreSQL server is stopped.');
} else {
  if (!existsSync('.env')) {
    const example = readFileSync('.env.example', 'utf8');
    writeFileSync('.env', example.replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`), { flag: 'wx' });
    console.log('.env created with a random local database password.');
  }
  process.loadEnvFile('.env');
  const port = Number(process.env.POSTGRES_PORT ?? '5432');
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const database = process.env.POSTGRES_DB;
  if (!['127.0.0.1', 'localhost'].includes(process.env.POSTGRES_HOST ?? '127.0.0.1') ||
      !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password || !database ||
      /[\r\n]/.test(password) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(user) ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) {
    throw new Error('This local launcher requires a local host and valid POSTGRES_* settings in .env.');
  }
  mkdirSync(directory, { recursive: true });
  if (!existsSync(join(cluster, 'PG_VERSION'))) {
    const passwordFile = join(directory, `init-${randomUUID()}.pw`);
    try {
      writeFileSync(passwordFile, password + '\n', { flag: 'wx' });
      run(initdb, ['-D', cluster, '-U', user, '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
    } finally {
      if (existsSync(passwordFile)) unlinkSync(passwordFile);
    }
  }
  if (!await running()) {
    run(pg_ctl, ['start', '-D', cluster, '-l', log, '-o', `-h 127.0.0.1 -p ${port}`, '-w', '-t', '30']);
  }
  const client = new Client({ host: '127.0.0.1', port, user, password, database: 'postgres', connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!found.rows.length) await client.query(`CREATE DATABASE "${database}"`);
    console.log(`PostgreSQL ready on 127.0.0.1:${port}. Data: ${cluster}`);
  } finally { await client.end(); }
}
