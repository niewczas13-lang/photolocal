import { win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const VOLUME_NAME = /^photolocal-production-nas-[a-f0-9]{32}$/;
const INTEGRATIONS = [
  'ADRESY_APP_BASE_URL', 'ADRESY_APP_API_KEY', 'ADRESY_APP_REVERSE_RADIUS_METERS',
  'NOMINATIM_BASE_URL', 'NOMINATIM_USER_AGENT', 'OLLAMA_URL', 'OLLAMA_VISION_MODEL',
  'OLLAMA_VISION_MODELS', 'OLLAMA_NOTES_MODEL',
];
const PROJECT_NAME = 'photolocal-production';
const literal = value => value.replaceAll('$', () => '$$');
const slash = value => value.replaceAll('\\', '/');

function fail(code = 'INVALID_PRODUCTION_CONFIGURATION') {
  throw Object.assign(new Error(code), { code });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

function inside(candidate, root) {
  const difference = win32.relative(root, candidate);
  return difference === '' || (difference !== '..' && !difference.startsWith('..\\') && !win32.isAbsolute(difference));
}

function same(left, right) { return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase(); }
function overlap(left, right) { return inside(left, right) || inside(right, left); }

function windowsPath(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^[a-z]:[\\/]/i.test(value) ||
      /[,\x00-\x1f\x7f]/.test(value) || /[<>:"|?*]/.test(value.slice(2)) ||
      value.split(/[\\/]/).some(part => part === '.' || part === '..' || /[. ]$/.test(part))) fail();
  const normalized = win32.normalize(value);
  if (same(normalized, win32.parse(normalized).root)) fail();
  return normalized.replace(/[\\/]$/, '');
}

function nativePath(value, fallback, backendRoot, productionRoot) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || value !== value.trim() || /[,\x00-\x1f\x7f]/.test(value) ||
      (/^[a-z]:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) ||
      (win32.isAbsolute(value) && !/^[a-z]:[\\/]/i.test(value))) fail('UNSUPPORTED_SOURCE_PATH');
  let path;
  try { path = windowsPath(win32.resolve(backendRoot, value)); } catch { fail('UNSUPPORTED_SOURCE_PATH'); }
  if (!inside(path, productionRoot) || same(path, productionRoot)) fail('UNSUPPORTED_SOURCE_PATH');
  return path;
}

function publicOrigin(value) {
  try {
    if (typeof value !== 'string' || value !== value.trim() || !/^https:\/\/[^/?#\s]+\/?$/i.test(value)) fail();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail();
    return url.origin;
  } catch { fail('INVALID_PUBLIC_ORIGIN'); }
}

function ollamaEndpoint(value) {
  if (value === undefined || value.trim() === '') return 'http://host.docker.internal:11434';
  const endpoint = value.trim();
  let url;
  try { url = new URL(endpoint); } catch { fail('INVALID_OLLAMA_URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('INVALID_OLLAMA_URL');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) return endpoint;
  // Replace only the loopback host; retain path, query, credentials and port literally.
  const start = endpoint.indexOf('://') + 3;
  const relativeEnd = endpoint.slice(start).search(/[/?#]/);
  const end = relativeEnd === -1 ? endpoint.length : start + relativeEnd;
  const authority = endpoint.slice(start, end);
  const hostStart = authority.lastIndexOf('@') + 1;
  const hostAndPort = authority.slice(hostStart);
  const portStart = hostAndPort.startsWith('[') ? hostAndPort.indexOf(']') + 1 : hostAndPort.indexOf(':');
  const port = portStart < 0 ? '' : hostAndPort.slice(portStart);
  return `${endpoint.slice(0, start)}${authority.slice(0, hostStart)}host.docker.internal${port}${endpoint.slice(end)}`;
}

/** Pure configuration preparation: no filesystem access, Docker calls or secret-bearing errors. */
export function buildProductionConfiguration(input) {
  if (!object(input) || !object(input.sourceEnvironment)) fail();
  const productionRoot = windowsPath(input.productionRoot);
  const stagingRoot = windowsPath(input.stagingRoot);
  const runDirectory = windowsPath(input.runDirectory);
  const networkPrefix = windowsPath(input.networkPrefix);
  const stagingData = win32.join(stagingRoot, 'docker-data');
  if (overlap(productionRoot, stagingRoot) || !inside(runDirectory, stagingData) || same(runDirectory, stagingData) ||
      overlap(networkPrefix, productionRoot) || overlap(networkPrefix, stagingRoot)) fail();
  const storage = input.storage;
  if (!object(storage) || storage.version !== 2 || storage.accessMode !== 'rw' || storage.containerPath !== '/nas' ||
      typeof storage.volumeName !== 'string' || !VOLUME_NAME.test(storage.volumeName) || typeof storage.subdirectory !== 'string' ||
      /[\\:\x00-\x1f\x7f]/.test(storage.subdirectory) ||
      storage.subdirectory.split('/').some(part => ['', '.', '..'].includes(part)) ||
      Object.keys(storage).some(key => !['version', 'accessMode', 'volumeName', 'containerPath', 'subdirectory'].includes(key)) ||
      typeof input.imageId !== 'string' || !IMAGE_ID.test(input.imageId)) fail();
  const environment = input.sourceEnvironment;
  for (const name of ['PHOTO_LOCAL_PORT', 'PHOTO_LOCAL_DB', 'GOOGLE_CHAT_DOWNLOAD_ROOT', 'PHOTO_LOCAL_SHARED_ROOTS', ...INTEGRATIONS]) {
    if (environment[name] !== undefined && typeof environment[name] !== 'string') fail('INVALID_SOURCE_ENVIRONMENT');
  }
  if (environment.PHOTO_LOCAL_PORT !== undefined &&
      (environment.PHOTO_LOCAL_PORT.trim() === '' || Number(environment.PHOTO_LOCAL_PORT) !== 4873)) fail('SOURCE_PORT_MISMATCH');
  if (environment.PHOTO_LOCAL_SHARED_ROOTS !== undefined && environment.PHOTO_LOCAL_SHARED_ROOTS !== '') fail('SOURCE_SHARED_ROOTS_REQUIRE_MAPPING');
  const backendRoot = win32.join(productionRoot, 'backend');
  const source = {
    databasePath: nativePath(environment.PHOTO_LOCAL_DB, win32.join(backendRoot, 'data', 'photo-local.sqlite'), backendRoot, productionRoot),
    downloadsPath: nativePath(environment.GOOGLE_CHAT_DOWNLOAD_ROOT, win32.join(productionRoot, 'pobierzchat', 'pobrane_zdjecia'), backendRoot, productionRoot),
    localPhotosPath: win32.join(backendRoot, 'zdjęcia'),
  };
  const databaseDirectory = win32.dirname(source.databasePath);
  if (overlap(source.downloadsPath, source.localPhotosPath) || overlap(databaseDirectory, source.downloadsPath) ||
      overlap(databaseDirectory, source.localPhotosPath)) fail('SOURCE_PATHS_OVERLAP');
  const nasRoot = `/nas/${storage.subdirectory}`;
  const runtimeEnvironment = {
    PHOTO_LOCAL_HOST: '0.0.0.0', PHOTO_LOCAL_PORT: '4873', PHOTO_LOCAL_AUTH: 'enabled',
    PHOTO_LOCAL_DB: '/data/photo-local.sqlite', PHOTO_LOCAL_LOG: '/data/logs/app.log',
    PHOTO_LOCAL_SHARED_ROOTS: JSON.stringify([
      { path: '/photos', label: 'Zdjęcia lokalne' }, { path: nasRoot, label: 'NAS' },
    ]),
    GOOGLE_CHAT_PYTHON: '/opt/venv/bin/python', GOOGLE_CHAT_CREDENTIALS_FILE: '/google/credentials.json',
    GOOGLE_CHAT_TOKEN_FILE: '/google/token.json', GOOGLE_CHAT_DOWNLOAD_ROOT: '/downloads',
    GOOGLE_CHAT_JOB_STATE_FILE: '/data/google-chat-download.json',
    GOOGLE_CHAT_OAUTH_REDIRECT_URI: `${publicOrigin(input.publicUrl)}/api/google-chat/auth/callback`,
    OLLAMA_URL: ollamaEndpoint(environment.OLLAMA_URL),
  };
  const integrationSettingNames = INTEGRATIONS.filter(name => environment[name] !== undefined).sort();
  for (const name of integrationSettingNames) {
    if (/[\x00\r\n]/.test(environment[name])) fail('INVALID_INTEGRATION_SETTING');
    if (name !== 'OLLAMA_URL') runtimeEnvironment[name] = environment[name];
  }
  const bind = (directory, target) => ({ type: 'bind', source: literal(slash(win32.join(runDirectory, directory))),
    target, read_only: false, bind: { create_host_path: false } });
  return {
    source,
    mapping: [
      { from: networkPrefix, to: nasRoot },
      { from: source.localPhotosPath, to: '/legacy-local-photos' },
      { from: source.downloadsPath, to: '/downloads' },
    ],
    integrationSettingNames,
    compose: {
      name: PROJECT_NAME,
      services: { photolocal: {
        image: input.imageId, pull_policy: 'never', user: '1000:1000', restart: 'unless-stopped', init: true,
        ports: [{ host_ip: '0.0.0.0', published: '4873', target: 4873, protocol: 'tcp' }],
        environment: Object.fromEntries(Object.entries(runtimeEnvironment).map(([name, value]) => [name, literal(value)])),
        extra_hosts: { 'host.docker.internal': 'host-gateway' },
        volumes: [bind('data', '/data'), bind('google', '/google'), bind('downloads', '/downloads'),
          bind('local-photos', '/legacy-local-photos'), bind('photos', '/photos'),
          { type: 'volume', source: 'production_nas', target: '/nas', read_only: false, volume: { nocopy: true } }],
        healthcheck: {
          test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4873/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
          interval: '30s', timeout: '5s', start_period: '30s', retries: 3,
        },
        stop_grace_period: '30s',
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      } },
      volumes: { production_nas: { external: true, name: storage.volumeName } },
    },
  };
}

function normalizeResolved(value) {
  if (!object(value)) fail();
  const config = structuredClone(value);
  if (config.networks !== undefined) {
    if (isDeepStrictEqual(config.networks.default?.ipam, {})) delete config.networks.default.ipam;
    if (!isDeepStrictEqual(config.networks, { default: { name: `${PROJECT_NAME}_default` } })) fail();
    delete config.networks;
  }
  const app = config.services?.photolocal;
  if (!object(app)) fail();
  for (const name of ['command', 'entrypoint']) if (app[name] === null) delete app[name];
  if (app.networks !== undefined) {
    if (!isDeepStrictEqual(app.networks, { default: null }) && !isDeepStrictEqual(app.networks, { default: {} })) fail();
    delete app.networks;
  }
  if (Array.isArray(app.ports)) for (const port of app.ports) {
    if (port.mode !== undefined) { if (port.mode !== 'ingress') fail(); delete port.mode; }
    if (typeof port.published === 'number') port.published = String(port.published);
    if (port.protocol === undefined) port.protocol = 'tcp';
  }
  if (object(app.extra_hosts)) {
    for (const [name, host] of Object.entries(app.extra_hosts)) {
      if (Array.isArray(host) && host.length === 1) app.extra_hosts[name] = host[0];
    }
  } else if (isDeepStrictEqual(app.extra_hosts, ['host.docker.internal:host-gateway']) ||
      isDeepStrictEqual(app.extra_hosts, ['host.docker.internal=host-gateway'])) {
    app.extra_hosts = { 'host.docker.internal': 'host-gateway' };
  }
  if (Array.isArray(app.volumes)) for (const mount of app.volumes) {
    if (mount.read_only === undefined) mount.read_only = false;
    if (mount.type === 'bind') mount.source = windowsPath(mount.source).toLowerCase();
  }
  return config;
}

/** Check the complete resolved config, allowing only harmless Compose normalization. */
export function verifyResolvedProductionConfiguration(resolved, input) {
  try {
    // `compose config` re-escapes dollars in its reusable serialized output.
    const expected = normalizeResolved(buildProductionConfiguration(input).compose);
    const actual = normalizeResolved(resolved);
    if (!isDeepStrictEqual(actual, expected)) fail();
  } catch { fail('UNSAFE_PRODUCTION_CONFIGURATION'); }
}
