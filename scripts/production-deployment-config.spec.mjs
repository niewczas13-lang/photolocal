import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { buildProductionConfiguration, verifyResolvedProductionConfiguration } from './production-deployment-config.mjs';

const storage = { version: 2, accessMode: 'rw', volumeName: 'photolocal-production-nas-0123456789abcdef0123456789abcdef', containerPath: '/nas', subdirectory: 'Projects' };
const input = {
  productionRoot: 'C:\\PhotoLocal', stagingRoot: 'C:\\PhotoLocal-staging',
  runDirectory: 'C:\\PhotoLocal-staging\\docker-data\\production-123',
  networkPrefix: 'Z:\\Projects', storage, imageId: `sha256:${'a'.repeat(64)}`,
  publicUrl: 'https://photos.example.test', sourceEnvironment: {},
};
const privateValue = 'SYNTHETIC_PRIVATE_${NOT_AN_ENV} $literal $$ zażółć';

function normalizedFixture(configuration = input) {
  const result = structuredClone(buildProductionConfiguration(configuration).compose);
  result.networks = { default: { name: 'photolocal-production_default', ipam: {} } };
  const app = result.services.photolocal;
  app.command = null;
  app.entrypoint = null;
  app.networks = { default: null };
  app.ports[0].mode = 'ingress';
  app.extra_hosts = { 'host.docker.internal': ['host-gateway'] };
  for (const mount of app.volumes) if (mount.read_only === false) delete mount.read_only;
  return result;
}

test('builds an independent production service from a pinned image and copied local paths', () => {
  const plan = buildProductionConfiguration(input);
  assert.deepEqual(plan.source, {
    databasePath: 'C:\\PhotoLocal\\backend\\data\\photo-local.sqlite',
    downloadsPath: 'C:\\PhotoLocal\\pobierzchat\\pobrane_zdjecia',
    localPhotosPath: 'C:\\PhotoLocal\\backend\\zdjęcia',
  });
  assert.deepEqual(plan.mapping, [
    { from: 'Z:\\Projects', to: '/nas/Projects' },
    { from: plan.source.localPhotosPath, to: '/legacy-local-photos' },
    { from: plan.source.downloadsPath, to: '/downloads' },
  ]);
  assert.equal(plan.compose.name, 'photolocal-production');
  assert.deepEqual(Object.keys(plan.compose.services), ['photolocal']);
  const app = plan.compose.services.photolocal;
  assert.equal(app.image, input.imageId);
  assert.equal(app.user, '1000:1000');
  assert.equal(app.pull_policy, 'never');
  assert.equal(app.init, true);
  assert.equal(app.restart, 'unless-stopped');
  assert.equal(app.stop_grace_period, '30s');
  assert.deepEqual(app.ports, [{ host_ip: '0.0.0.0', published: '4873', target: 4873, protocol: 'tcp' }]);
  assert.equal(app.environment.PHOTO_LOCAL_AUTH, 'enabled');
  assert.equal(app.environment.GOOGLE_CHAT_OAUTH_REDIRECT_URI, 'https://photos.example.test/api/google-chat/auth/callback');
  assert.equal(app.environment.OLLAMA_URL, 'http://host.docker.internal:11434');
  assert.equal(app.volumes.length, 6);
  for (const name of ['data', 'google', 'downloads', 'photos']) {
    const mount = app.volumes.find(value => value.target === `/${name}`);
    assert.equal(mount.source, `C:/PhotoLocal-staging/docker-data/production-123/${name}`);
    assert.equal(mount.bind.create_host_path, false);
  }
  assert.equal(app.volumes.find(value => value.target === '/legacy-local-photos').source,
    'C:/PhotoLocal-staging/docker-data/production-123/local-photos');
  const nas = app.volumes.find(value => value.target === '/nas');
  assert.deepEqual(nas, { type: 'volume', source: 'production_nas', target: '/nas', read_only: false, volume: { nocopy: true } });
  assert.deepEqual(plan.compose.volumes.production_nas, { external: true, name: storage.volumeName });
  assert.ok(!['build', 'extends', 'env_file', 'depends_on', 'command', 'entrypoint'].some(key => key in app));
  assert.deepEqual(plan.integrationSettingNames, []);
  assert.deepEqual(input.sourceEnvironment, {});
});

test('resolves custom native paths against the backend working directory', () => {
  const plan = buildProductionConfiguration({ ...input, sourceEnvironment: {
    PHOTO_LOCAL_DB: 'data\\custom.sqlite', GOOGLE_CHAT_DOWNLOAD_ROOT: '..\\chat-downloads',
  } });
  assert.equal(plan.source.databasePath, 'C:\\PhotoLocal\\backend\\data\\custom.sqlite');
  assert.equal(plan.source.downloadsPath, 'C:\\PhotoLocal\\chat-downloads');
  assert.equal(plan.mapping[2].from, plan.source.downloadsPath);
  const defaults = buildProductionConfiguration({ ...input, sourceEnvironment: { PHOTO_LOCAL_DB: '', GOOGLE_CHAT_DOWNLOAD_ROOT: '', PHOTO_LOCAL_SHARED_ROOTS: '' } });
  assert.deepEqual(defaults.source, buildProductionConfiguration(input).source);
});

test('copies only allowlisted integration settings and escapes Compose interpolation literally', () => {
  const sourceEnvironment = {
    ADRESY_APP_BASE_URL: 'https://geocode.example.test/api/v1', ADRESY_APP_API_KEY: privateValue,
    ADRESY_APP_REVERSE_RADIUS_METERS: '350', NOMINATIM_BASE_URL: 'https://maps.example.test',
    NOMINATIM_USER_AGENT: 'PhotoLocal Example', OLLAMA_VISION_MODEL: 'vision:8b',
    OLLAMA_VISION_MODELS: 'vision:8b,vision:3b', OLLAMA_NOTES_MODEL: 'notes:7b',
    GOOGLE_CHAT_PYTHON: 'C:\\Python\\python.exe', GOOGLE_CHAT_INVITE_HEADLESS: 'true',
    GOOGLE_CHAT_INVITE_PROFILE_DIR: 'C:\\Private', OTHER_SECRET: privateValue,
  };
  const plan = buildProductionConfiguration({ ...input, sourceEnvironment });
  assert.equal(plan.compose.services.photolocal.environment.ADRESY_APP_API_KEY, privateValue.replaceAll('$', () => '$$'));
  assert.equal(plan.compose.services.photolocal.environment.GOOGLE_CHAT_PYTHON, '/opt/venv/bin/python');
  assert.ok(!Object.keys(plan.compose.services.photolocal.environment).some(key => key.startsWith('GOOGLE_CHAT_INVITE') || key === 'OTHER_SECRET'));
  assert.deepEqual(plan.integrationSettingNames, Object.keys(sourceEnvironment).slice(0, 8).sort());
  assert.ok(!JSON.stringify(plan.integrationSettingNames).includes('SYNTHETIC_PRIVATE'));
  assert.doesNotThrow(() => verifyResolvedProductionConfiguration(normalizedFixture({ ...input, sourceEnvironment }), { ...input, sourceEnvironment }));
});

for (const [source, expected] of [
  ['http://localhost:11434', 'http://host.docker.internal:11434'],
  ['http://127.0.0.1:11434/base', 'http://host.docker.internal:11434/base'],
  ['http://[::1]:11434/', 'http://host.docker.internal:11434/'],
  ['https://models.example.test:11434/custom?mode=1', 'https://models.example.test:11434/custom?mode=1'],
  ['', 'http://host.docker.internal:11434'],
]) test(`preserves or translates the Ollama endpoint ${source || '(default)'}`, () => {
  const plan = buildProductionConfiguration({ ...input, sourceEnvironment: { OLLAMA_URL: source } });
  assert.equal(plan.compose.services.photolocal.environment.OLLAMA_URL, expected);
  assert.deepEqual(plan.integrationSettingNames, ['OLLAMA_URL']);
});

for (const patch of [
  { productionRoot: '\\\\server\\share' }, { productionRoot: 'C:\\' },
  { stagingRoot: 'C:\\PhotoLocal\\staging' }, { productionRoot: 'C:\\PhotoLocal-staging\\old' },
  { runDirectory: 'C:\\PhotoLocal-staging\\docker-data' },
  { runDirectory: 'C:\\PhotoLocal-staging\\docker-data\\..\\production' },
  { runDirectory: 'C:\\elsewhere\\production' }, { stagingRoot: 'C:\\stage,bad' },
  { networkPrefix: 'Z:\\Projects\\..\\Other' }, { networkPrefix: 'C:\\PhotoLocal' },
  { imageId: 'photolocal:latest' },
  { imageId: [input.imageId] },
  { storage: { ...storage, version: 1 } }, { storage: { ...storage, accessMode: 'ro' } },
  { storage: { ...storage, volumeName: 'photolocal-staging-nas-0123456789abcdef0123456789abcdef' } },
  { storage: { ...storage, volumeName: [storage.volumeName] } },
  { storage: { ...storage, containerPath: '/other' } }, { storage: { ...storage, subdirectory: '../Other' } },
  { publicUrl: 'http://photos.example.test' }, { publicUrl: 'https://photos.example.test/other' },
  { publicUrl: 'https://name:password@photos.example.test' }, { publicUrl: 'https://photos.example.test?secret=1' },
  { sourceEnvironment: { PHOTO_LOCAL_PORT: '' } }, { sourceEnvironment: { PHOTO_LOCAL_PORT: '4874' } },
  { sourceEnvironment: { PHOTO_LOCAL_SHARED_ROOTS: '[{"path":"Z:\\\\Other"}]' } },
  { sourceEnvironment: { PHOTO_LOCAL_DB: 'D:\\Other\\photo.sqlite' } },
  { sourceEnvironment: { GOOGLE_CHAT_DOWNLOAD_ROOT: '..\\..\\Other' } },
  { sourceEnvironment: { GOOGLE_CHAT_DOWNLOAD_ROOT: 'zdjęcia' } },
  { sourceEnvironment: { GOOGLE_CHAT_DOWNLOAD_ROOT: 'data' } },
  { sourceEnvironment: { PHOTO_LOCAL_DB: 'zdjęcia\\photo.sqlite' } },
  { sourceEnvironment: { PHOTO_LOCAL_DB: 'C:relative.sqlite' } },
  { sourceEnvironment: { OLLAMA_URL: 'not a URL' } },
]) test('rejects unsupported production configuration without values in errors', () => {
  assert.throws(() => buildProductionConfiguration({ ...input, ...patch }), error => {
    assert.match(error.code, /^[A-Z_]+$/);
    assert.equal(error.message, error.code);
    return true;
  });
});

test('accepts normalized production config and rejects changes to its service or bindings', () => {
  const normalized = normalizedFixture();
  assert.equal(verifyResolvedProductionConfiguration(normalized, input), undefined);
  for (const mutate of [
    config => { config.services.other = {}; },
    config => { config.services.photolocal.image = 'photolocal:latest'; },
    config => { config.services.photolocal.user = '0:0'; },
    config => { config.services.photolocal.privileged = true; },
    config => { config.services.photolocal.command = ['node', 'other.js']; },
    config => { config.services.photolocal.entrypoint = []; },
    config => { config.services.photolocal.environment.OTHER_SECRET = privateValue; },
    config => { config.services.photolocal.environment.PHOTO_LOCAL_AUTH = 'disabled'; },
    config => { config.services.photolocal.environment.GOOGLE_CHAT_OAUTH_REDIRECT_URI = ''; },
    config => { config.services.photolocal.ports[0].published = '4874'; },
    config => { config.services.photolocal.ports.push({ target: 443, published: '443' }); },
    config => { config.services.photolocal.volumes[0].source = 'C:/PhotoLocal/backend/data'; },
    config => { config.services.photolocal.volumes[0].bind.create_host_path = true; },
    config => { config.services.photolocal.volumes.find(value => value.target === '/nas').read_only = true; },
    config => { config.volumes.production_nas.driver_opts = { o: privateValue }; },
    config => { config.services.photolocal.extra_hosts['host.docker.internal'] = ['127.0.0.1']; },
    config => { config.networks.default.external = true; },
    config => { config.services.photolocal.healthcheck.disable = true; },
    config => { config.services.photolocal.restart = 'no'; },
    config => { config.services.photolocal.env_file = ['.env']; },
  ]) {
    const unsafe = structuredClone(normalized);
    mutate(unsafe);
    assert.throws(() => verifyResolvedProductionConfiguration(unsafe, input), { code: 'UNSAFE_PRODUCTION_CONFIGURATION' });
  }
});

test('accepts Compose 2.38 omitting false create_host_path without accepting true or changing input', () => {
  const normalized = normalizedFixture();
  for (const mount of normalized.services.photolocal.volumes) {
    if (mount.type === 'bind') delete mount.bind.create_host_path;
  }
  const before = structuredClone(normalized);
  assert.doesNotThrow(() => verifyResolvedProductionConfiguration(normalized, input));
  assert.deepEqual(normalized, before);
  normalized.services.photolocal.volumes[0].bind.create_host_path = true;
  assert.throws(() => verifyResolvedProductionConfiguration(normalized, input), { code: 'UNSAFE_PRODUCTION_CONFIGURATION' });
});

test('actual Docker Compose normalization preserves private literals without contacting an engine', context => {
  const tempRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(tempRoot, 'photolocal-production-config-'));
  context.after(() => {
    assert.ok(resolve(directory).startsWith(`${tempRoot}${sep}`));
    assert.notEqual(resolve(directory), tempRoot);
    rmSync(directory, { recursive: true, force: true });
  });
  const configuration = { ...input, sourceEnvironment: { ADRESY_APP_API_KEY: privateValue, OLLAMA_URL: 'http://localhost:11434' } };
  const plan = buildProductionConfiguration(configuration);
  const result = spawnSync('docker', ['compose', '--project-directory', directory, '-p', 'photolocal-production', '-f', '-', 'config', '--format', 'json'], {
    input: JSON.stringify(plan.compose), encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, DOCKER_HOST: 'tcp://127.0.0.1:1', DOCKER_CONTEXT: '', NOT_AN_ENV: 'must-not-expand' },
  });
  if (result.error?.code === 'ENOENT') return context.skip('Docker CLI unavailable');
  assert.equal(result.status, 0, 'Compose accepts a standalone configuration without an engine');
  const normalized = JSON.parse(result.stdout);
  const rendered = normalized.services.photolocal.environment.ADRESY_APP_API_KEY;
  assert.equal(rendered, privateValue.replaceAll('$', () => '$$'));
  assert.equal(rendered.replaceAll('$$', '$'), privateValue);
  assert.doesNotThrow(() => verifyResolvedProductionConfiguration(normalized, configuration));
});
