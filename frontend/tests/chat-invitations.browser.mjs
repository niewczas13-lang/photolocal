import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(repo, 'backend/package.json'));
const { chromium } = require('playwright-core');
const { WebSocketServer } = require('ws');
const desktop = new WebSocketServer({ noServer: true });
let desktopConnections = 0;
desktop.on('connection', socket => {
  desktopConnections += 1;
  let phase = 0;
  socket.send(Buffer.from('RFB 003.008\n'));
  socket.on('message', data => {
    if (phase === 0) {
      assert.equal(data.toString(), 'RFB 003.008\n');
      socket.send(Buffer.from([1, 1]));
    } else if (phase === 1) {
      assert.equal(data[0], 1);
      socket.send(Buffer.alloc(4));
    } else if (phase === 2) {
      const name = Buffer.from('Synthetic login desktop');
      const init = Buffer.alloc(24 + name.length);
      init.writeUInt16BE(1280, 0);
      init.writeUInt16BE(900, 2);
      init[4] = 32; init[5] = 24; init[7] = 1;
      for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
      init[14] = 16; init[15] = 8;
      init.writeUInt32BE(name.length, 20);
      name.copy(init, 24);
      socket.send(init);
    }
    phase += 1;
  });
});
const entry = '/__invitation_test__.tsx';
const entryPath = join(repo, 'frontend', entry.slice(1)).replaceAll('\\', '/');
const server = await createServer({
  configFile: false, root: join(repo, 'frontend'), logLevel: 'error',
  resolve: { alias: { '@': join(repo, 'frontend/src') } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [tailwindcss(), react(), {
    name: 'invitation-fixture',
    resolveId(id) { if (id === entry) return entryPath; },
    load(id) {
      if (id.replaceAll('\\', '/') !== entryPath) return;
      return `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import '/src/styles.css';
        import ChatImportPanel from '/src/components/ChatImportPanel.tsx';
        createRoot(document.getElementById('root')).render(<ChatImportPanel
          projectId="test-project" project={{id:'test-project',name:'Test',
          googleChatSpaceName:null,googleChatSpaceDisplayName:null,googleChatLastDownloadAt:null}}
          batches={[]} onChanged={async()=>{}} />);`;
    },
    configureServer(instance) {
      instance.middlewares.use(async (request, response, next) => {
        if (request.url !== '/__test__') return next();
        const html = await instance.transformIndexHtml('/__test__.html',
          `<!doctype html><html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
        response.setHeader('Content-Type', 'text/html');
        response.end(html);
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  server.httpServer.on('upgrade', (request, socket, head) => {
    if (request.url === '/api/google-chat/invites/browser/test-session/socket') {
      desktop.handleUpgrade(request, socket, head, client => desktop.emit('connection', client));
    }
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  const writes = [];
  let spacesRefreshes = 0;
  let listMode = 'invites';
  let accepted = true;
  let stalledClose = false;
  const pending = [
    { key: 'aaaaaaaaaaaaaaaa', roomName: 'Zagłoby 39', senderEmail: 'sender@example.test', textPreview: 'Zaproszenie od: sender@example.test', canAccept: true },
    { key: 'bbbbbbbbbbbbbbbb', roomName: 'Zagłoby 40', senderEmail: null, textPreview: 'Zaproszenie do pokoju', canAccept: false, reason: 'Nie można jednoznacznie potwierdzić pokoju.' },
  ];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/config') return route.fulfill({ json: {
      googleChatDownloadRoot: '/downloads', googleChatInviteProfileDir: '', googleChatInviteMode: 'DOCKER_BROWSER',
    } });
    if (path === '/api/google-chat/auth/status') return route.fulfill({ json: {
      state: 'CONNECTED', canConnect: true, message: 'Połączono', inviteMode: 'GOOGLE_CHAT_LINK',
    } });
    if (path === '/api/google-chat/invites/list') {
      if (listMode === 'error') return route.fulfill({ status: 502, json: { error: 'Przeglądarka jest niedostępna.' } });
      return route.fulfill({ json: { invites: listMode === 'login' ? [] : pending,
        session: { state: listMode === 'login' ? 'NEEDS_LOGIN' : 'ACTIVE', message: 'Sesja Google', url: null, title: null, checkedAt: new Date().toISOString() },
        url: 'https://chat.google.com', profileDir: '',
      } });
    }
    if (path === '/api/google-chat/invites/accept') {
      writes.push(request.postDataJSON());
      const invite = accepted ? pending.shift() : pending[0];
      return route.fulfill({ json: { accepted, invite } });
    }
    if (path === '/api/google-chat/spaces') {
      spacesRefreshes += 1;
      return route.fulfill({ json: [] });
    }
    if (path === '/api/google-chat/invites/browser/start') {
      writes.push({ start: true });
      return route.fulfill({ json: { sessionId: 'test-session', expiresAt: new Date(Date.now() + 600000).toISOString(),
        websocketPath: '/api/google-chat/invites/browser/test-session/socket' } });
    }
    if (path === '/api/google-chat/invites/browser/test-session' && request.method() === 'DELETE') {
      writes.push({ released: true });
      if (stalledClose) return;
      return route.fulfill({ json: { released: true } });
    }
    if (path.endsWith('/status')) return route.fulfill({ json: { state: 'IDLE', recentLines: [] } });
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto(origin + '/__test__');
  const find = page.getByRole('button', { name: 'Znajdź zaproszenia', exact: true });
  await find.waitFor();
  assert.deepEqual(writes, [], 'Opening the panel must not join any room');
  await find.click();
  await page.getByRole('heading', { name: 'Zagłoby 39', exact: true }).waitFor();
  assert.deepEqual(writes, [], 'Finding invitations must not accept them');
  assert.equal(await page.getByRole('button', { name: 'Akceptuj zaproszenie: Zagłoby 40' }).isEnabled(), false);
  if (process.env.PHOTO_LOCAL_QA_SCREENSHOT) {
    await page.screenshot({ path: process.env.PHOTO_LOCAL_QA_SCREENSHOT.replace('.png', '-invitations.png') });
  }
  await page.getByRole('button', { name: 'Akceptuj zaproszenie: Zagłoby 39' }).click();
  await page.getByText('Zaakceptowano zaproszenie do pokoju Zagłoby 39.', { exact: true }).waitFor();
  assert.deepEqual(writes, [{ inviteKey: 'aaaaaaaaaaaaaaaa' }]);
  assert.equal(spacesRefreshes, 1, 'A confirmed join refreshes available rooms');
  assert.equal(await page.getByRole('heading', { name: 'Zagłoby 39', exact: true }).count(), 0);

  accepted = false;
  pending.unshift({ key: 'cccccccccccccccc', roomName: 'Zagłoby 41', senderEmail: null,
    textPreview: 'Zaproszenie do pokoju', canAccept: true });
  await find.click();
  await page.getByRole('button', { name: 'Akceptuj zaproszenie: Zagłoby 41' }).click();
  await page.getByText('Nie potwierdzono przyjęcia zaproszenia. Wyszukaj zaproszenia ponownie.', { exact: true }).waitFor();
  assert.equal(spacesRefreshes, 1, 'An unconfirmed join must not be reported as successful');
  assert.equal(await page.getByText(/Zaakceptowano zaproszenie do pokoju/).count(), 0);

  listMode = 'error';
  await find.click();
  await page.getByText('Przeglądarka jest niedostępna.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Akceptuj zaproszenie: Zagłoby 40' }).count(), 0,
    'A failed refresh must not leave stale invitations actionable');
  listMode = 'login';
  await find.click();
  await page.getByText(/Zaloguj to samo konto Google/).waitFor();
  await page.getByRole('button', { name: 'Zaloguj Google w Romku', exact: true }).click();
  await page.getByRole('dialog', { name: 'Logowanie Google do zaproszeń' }).waitFor();
  await page.getByText('Okno Google jest gotowe. Kliknij w nie, aby używać klawiatury.', { exact: true }).waitFor();
  assert.equal(desktopConnections, 1, 'The real noVNC client must connect to the session endpoint');
  await page.getByRole('dialog').locator('canvas').click();
  await page.getByRole('button', { name: 'Zamknij okno logowania', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assert.ok(writes.some(write => write.released), 'Closing the browser must release its login lease');

  stalledClose = true;
  await page.getByRole('button', { name: 'Zaloguj Google w Romku', exact: true }).click();
  await page.getByRole('dialog', { name: 'Logowanie Google do zaproszeń' }).waitFor();
  await page.getByRole('button', { name: 'Zamknij okno logowania', exact: true }).click();
  await page.getByText('Serwer nie odpowiedział na czas. Wyszukaj zaproszenia ponownie, aby sprawdzić ich stan.',
    { exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await find.isEnabled(), true, 'A stalled lease release must not leave the panel blocked');
  assert.deepEqual(errors, []);
  if (process.env.PHOTO_LOCAL_QA_SCREENSHOT) await page.screenshot({ path: process.env.PHOTO_LOCAL_QA_SCREENSHOT });
  console.log('INVITATION_BROWSER_QA_OK: discovery, selected acceptance, ambiguous invitation, unconfirmed join, refresh, stale-list error, login, lease release, close timeout');
} finally {
  await browser?.close();
  for (const socket of desktop.clients) socket.terminate();
  desktop.close();
  await server.close();
}
