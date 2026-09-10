// Sent to `docker run/exec node --input-type=module -` over stdin by docker-smoke.mjs.
// All imports, filesystem writes, and HTTP requests execute inside the isolated test container.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { upsertAppUser } from './backend/dist/auth/app-auth.js';
import { runMigrations } from './backend/dist/db/migrations.js';
import { writeJsonAtomic } from './backend/dist/google-chat/google-chat-files.js';

assert.equal(process.env.PHOTO_LOCAL_SMOKE_TEST, '1', 'Run only through the Docker smoke harness');
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 1000, 'Exercise image-user volume permissions');
assert.equal(process.cwd(), '/app');
assert.equal(process.env.PHOTO_LOCAL_DB, '/data/photo-local.sqlite');
assert.equal(process.env.GOOGLE_CHAT_TOKEN_FILE, '/google/token.json');
assert.equal(process.env.GOOGLE_CHAT_DOWNLOAD_ROOT, '/downloads');

const mode = process.argv[2];
const projectId = 'ci-smoke-project';
const baseUrl = 'http://127.0.0.1:4873';
const fixturePath = '/data/smoke-fixture.json';
const cookiePath = '/data/smoke-cookie.json';

async function request(path, { cookie, method = 'GET', body } = {}) {
  assert.ok(path.startsWith('/') && !path.startsWith('//'), 'Only request container loopback');
  return fetch(`${baseUrl}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(5_000),
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(path, options = {}) {
  const response = await request(path, options);
  assert.equal(response.status, 200, `${path} must succeed`);
  return response.json();
}

if (mode === 'seed') {
  const db = new Database(process.env.PHOTO_LOCAL_DB);
  const fixture = { username: 'ci-smoke', password: randomUUID(), sentinel: randomUUID() };
  try {
    runMigrations(db);
    upsertAppUser(db, fixture.username, fixture.password);
    db.prepare(`INSERT INTO projects (id, name, project_type, splitter_topology,
      splitter_topology_source, gpkg_file_name, base_folder)
      VALUES (?, 'Synthetic CI project', 'SI', 'SINGLE', 'AUTO', 'synthetic.gpkg', '/photos/ci-project')`)
      .run(projectId);
  } finally { db.close(); }

  await mkdir('/photos/ci-project', { recursive: true });
  await mkdir('/downloads/ci-space', { recursive: true });
  await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } })
    .jpeg().toFile('/photos/ci-project/synthetic.jpg');
  await writeFile('/photos/ci-project/sentinel.txt', fixture.sentinel);
  await writeFile('/downloads/ci-space/sentinel.txt', fixture.sentinel);
  writeJsonAtomic('/downloads/.spaces.json', { 'spaces/ci': 'ci-space' });
  writeJsonAtomic('/google/credentials.json', {
    web: { client_id: 'synthetic-ci-client', client_secret: 'synthetic-ci-placeholder' },
  });
  writeJsonAtomic('/google/token.json', { token: 'synthetic-ci-access', refresh_token: 'synthetic-ci-refresh' });
  // Exercise atomic replacement on the mounted token directory too.
  writeJsonAtomic('/google/token.json', { token: 'synthetic-ci-replaced', refresh_token: 'synthetic-ci-refresh' });
  writeJsonAtomic('/data/google-chat-download.json', { version: 1, authRequired: false, status: {
    state: 'RUNNING', projectId, spaceName: 'spaces/ci', spaceDisplayName: 'CI Chat',
    rootPath: '/downloads/ci-space', downloadedFiles: 1, skippedFiles: 1, totalFiles: 3, recentLines: [],
  } });
  writeJsonAtomic(fixturePath, fixture);

  const help = spawnSync('/opt/venv/bin/python', ['/app/pobierzchat/chat.py', '--help'], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(help.status, 0, 'Bundled Python must load downloader dependencies');
  const missingToken = spawnSync('/opt/venv/bin/python', ['/app/pobierzchat/chat.py', '--list-spaces-json'], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, GOOGLE_CHAT_TOKEN_FILE: '/google/does-not-exist.json' },
  });
  assert.equal(missingToken.status, 3, 'Missing Google grant must fail without interactive login');
  assert.match(missingToken.stderr, /PHOTO_LOCAL_AUTH_REQUIRED/);
  process.stdout.write('Synthetic SQLite, native image processing, Python, and volume writes passed.\n');
} else {
  assert.ok(['initial', 'restored', 'logout'].includes(mode), 'Unknown probe mode');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  let cookie;
  if (mode === 'initial') {
    assert.equal((await request('/api/projects')).status, 401);
    assert.equal((await request('/api/google-chat/auth/status')).status, 401);
    assert.equal((await request('/api/auth/login', { method: 'POST',
      body: { username: fixture.username, password: 'wrong-synthetic-password' } })).status, 401);
    const login = await request('/api/auth/login', { method: 'POST',
      body: { username: fixture.username, password: fixture.password } });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie?.includes('HttpOnly'));
    cookie = setCookie.split(';')[0];
    assert.ok(cookie.startsWith('photo_local_session='));
    writeJsonAtomic(cookiePath, { cookie });
  } else {
    cookie = JSON.parse(await readFile(cookiePath, 'utf8')).cookie;
  }

  if (mode === 'logout') {
    assert.equal((await request('/api/auth/logout', { method: 'POST', cookie })).status, 200);
    assert.equal((await request('/api/auth/me', { cookie })).status, 401);
    process.stdout.write('Logout invalidated the persisted synthetic session.\n');
  } else {
    assert.deepEqual(await json('/health'), { ok: true });
    const frontend = await request('/');
    assert.equal(frontend.status, 200, 'Built frontend must be served by backend');
    const html = await frontend.text();
    const script = /<script\b[^>]*\bsrc=["']([^"']+)["']/.exec(html)?.[1];
    assert.ok(script, 'Built frontend must reference a JavaScript asset');
    assert.equal((await request(script)).status, 200, 'Built JavaScript asset must be available');
    assert.equal((await json('/api/auth/me', { cookie })).user.username, fixture.username);
    assert.ok((await json('/api/projects', { cookie })).some((project) => project.id === projectId));
    assert.equal((await json('/api/config', { cookie })).googleChatDownloadRoot, '/downloads');
    const roots = await json('/api/shared-folders/roots', { cookie });
    assert.deepEqual(roots.roots, [{ path: '/photos', label: 'CI photos', providerName: null }]);
    const google = await json('/api/google-chat/auth/status', { cookie });
    assert.equal(google.state, 'CONNECTED');
    assert.equal(google.canConnect, true);
    assert.equal(google.inviteMode, 'GOOGLE_CHAT_LINK');
    const job = await json(`/api/projects/${projectId}/google-chat/download/status`, { cookie });
    assert.equal(job.state, 'PAUSED', 'Saved RUNNING job must become resumable after startup');
    assert.equal(job.downloadedFiles, 1);
    assert.equal(job.skippedFiles, 1);
    assert.equal(job.totalFiles, 3);
    assert.equal(job.rootPath, '/downloads/ci-space');
    assert.equal(await readFile('/photos/ci-project/sentinel.txt', 'utf8'), fixture.sentinel);
    assert.equal(await readFile('/downloads/ci-space/sentinel.txt', 'utf8'), fixture.sentinel);
    assert.equal((await sharp('/photos/ci-project/synthetic.jpg').metadata()).width, 1);
    assert.deepEqual(JSON.parse(await readFile('/google/token.json', 'utf8')), {
      token: 'synthetic-ci-replaced', refresh_token: 'synthetic-ci-refresh',
    });
    process.stdout.write(`Container health, frontend, session, Google state, and persisted files passed (${mode}).\n`);
  }
}
