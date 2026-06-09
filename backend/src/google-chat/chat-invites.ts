import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { chromium } from 'playwright-core';

export const GOOGLE_CHAT_INVITES_URL =
  'https://chat.google.com/app/browse?q=&smembership=not_joined&sorganization=all';

export interface ChatInviteCandidate {
  key: string;
  roomName: string | null;
  senderEmail: string | null;
  textPreview: string;
}

export type ChatInviteSessionState = 'ACTIVE' | 'NEEDS_LOGIN' | 'UNKNOWN';

export interface ChatInviteSessionStatus {
  state: ChatInviteSessionState;
  message: string;
  url: string | null;
  title: string | null;
  checkedAt: string;
}

export interface ChatInviteBrowserLaunchInfo {
  executablePath: string | null;
  executableName: string | null;
  debugPort: number;
  profileDir: string;
  url: string;
  command: string | null;
}

export interface ChatInviteLoginLauncherInfo {
  launcherPath: string;
  command: string;
}

export interface ChatInviteDebugInfo {
  steps: string[];
  finalUrl: string | null;
  title: string | null;
  buttonCount: number;
  joinButtonCount: number;
  rawCandidateCount: number;
  bodyTextPreview: string;
  buttonLabelsPreview: string[];
  error: string | null;
}

export interface ChatInviteBrowserConfig {
  profileDir: string;
  headless: boolean;
  debugPort?: number;
  launcherPath?: string;
}

interface RawInviteCandidate {
  buttonIndex: number;
  text: string;
}

interface ChromeTargetInfo {
  url?: string;
  title?: string;
  type?: string;
}

function normalizePolishText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0142\u0141]/g, 'l')
    .replace(/[\u0105\u0104]/g, 'a')
    .replace(/[\u0107\u0106]/g, 'c')
    .replace(/[\u0119\u0118]/g, 'e')
    .replace(/[\u0144\u0143]/g, 'n')
    .replace(/[\u00f3\u00d3]/g, 'o')
    .replace(/[\u015b\u015a]/g, 's')
    .replace(/[\u017a\u0179\u017c\u017b]/g, 'z')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function createDebugInfo(): ChatInviteDebugInfo {
  return {
    steps: [],
    finalUrl: null,
    title: null,
    buttonCount: 0,
    joinButtonCount: 0,
    rawCandidateCount: 0,
    bodyTextPreview: '',
    buttonLabelsPreview: [],
    error: null,
  };
}

function inviteDebugPort(config: ChatInviteBrowserConfig): number {
  return config.debugPort ?? 9222;
}

function browserCandidates(): string[] {
  return [
    process.env.GOOGLE_CHAT_BROWSER_PATH ?? '',
    process.env.GOOGLE_CHROME_PATH ?? '',
    process.env.GOOGLE_EDGE_PATH ?? '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
}

function findBrowserExecutable(): string | null {
  return browserCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

function browserNameFromPath(executablePath: string | null): string | null {
  if (!executablePath) return null;
  const normalized = executablePath.toLowerCase();
  if (normalized.includes('msedge')) return 'Microsoft Edge';
  if (normalized.includes('chrome')) return 'Google Chrome';
  return executablePath.split(/[\\/]/).pop() ?? executablePath;
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function commandPromptDoubleQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildInviteLoginLauncherInfo(input: { launcherPath: string }): ChatInviteLoginLauncherInfo {
  const powerShellCommand = `Start-Process -FilePath ${powerShellSingleQuote(input.launcherPath)}`;
  return {
    launcherPath: input.launcherPath,
    command: `powershell -NoProfile -ExecutionPolicy Bypass -Command ${commandPromptDoubleQuote(powerShellCommand)}`,
  };
}

function buildInviteBrowserArgs(config: ChatInviteBrowserConfig): string[] {
  const debugPort = inviteDebugPort(config);
  return [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${config.profileDir}`,
    '--no-first-run',
    ...(config.headless ? ['--headless=new', '--disable-gpu'] : ['--new-window']),
    GOOGLE_CHAT_INVITES_URL,
  ];
}

export function buildInviteBrowserLaunchInfo(input: {
  config: ChatInviteBrowserConfig;
  executablePath: string | null;
}): ChatInviteBrowserLaunchInfo {
  const args = buildInviteBrowserArgs(input.config);
  const powerShellCommand = input.executablePath
    ? `Start-Process -FilePath ${powerShellSingleQuote(input.executablePath)} -ArgumentList @(${args
        .map(powerShellSingleQuote)
        .join(', ')})`
    : null;
  return {
    executablePath: input.executablePath,
    executableName: browserNameFromPath(input.executablePath),
    debugPort: inviteDebugPort(input.config),
    profileDir: input.config.profileDir,
    url: GOOGLE_CHAT_INVITES_URL,
    command: powerShellCommand
      ? `powershell -NoProfile -ExecutionPolicy Bypass -Command ${commandPromptDoubleQuote(powerShellCommand)}`
      : null,
  };
}

function launchExternalChrome(
  config: ChatInviteBrowserConfig,
  debug: ChatInviteDebugInfo,
): ChatInviteBrowserLaunchInfo {
  const browserPath = findBrowserExecutable();
  const launch = buildInviteBrowserLaunchInfo({ config, executablePath: browserPath });
  if (!browserPath) {
    throw new Error(
      'Nie znaleziono Google Chrome ani Microsoft Edge. Ustaw GOOGLE_CHAT_BROWSER_PATH albo GOOGLE_CHROME_PATH w .env.',
    );
  }

  debug.steps.push(`Uruchamiam przegladarke: ${browserPath}`);
  debug.steps.push(`Remote debugging port: ${launch.debugPort}`);

  const child = spawn(
    browserPath,
    buildInviteBrowserArgs(config),
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: config.headless,
    },
  );
  child.unref();
  return launch;
}

function launchLoginLauncher(launcherPath: string, debug: ChatInviteDebugInfo): ChatInviteLoginLauncherInfo {
  if (!existsSync(launcherPath)) {
    throw new Error(`Nie znaleziono launchera logowania Google Chat: ${launcherPath}`);
  }

  const launcher = buildInviteLoginLauncherInfo({ launcherPath });
  debug.steps.push(`Uruchamiam launcher logowania Google Chat: ${launcherPath}`);
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Start-Process -FilePath ${powerShellSingleQuote(launcherPath)}`,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return launcher;
}

async function waitForCdpEndpoint(config: ChatInviteBrowserConfig, debug: ChatInviteDebugInfo): Promise<string> {
  const debugPort = inviteDebugPort(config);
  const cdpUrl = `http://127.0.0.1:${debugPort}`;
  const versionUrl = `${cdpUrl}/json/version`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < 12_000) {
    try {
      const response = await fetch(versionUrl);
      if (response.ok) {
        debug.steps.push(`Chrome CDP gotowy: ${cdpUrl}`);
        return cdpUrl;
      }
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 500));
  }

  throw new Error(`Nie udalo sie polaczyc z Chrome CDP na porcie ${debugPort}`);
}

function sessionStatusFromTarget(target: ChromeTargetInfo | null): ChatInviteSessionStatus {
  const url = target?.url ?? null;
  const title = target?.title ?? null;
  const normalizedUrl = url?.toLowerCase() ?? '';
  const checkedAt = new Date().toISOString();

  if (normalizedUrl.includes('accounts.google.com')) {
    return {
      state: 'NEEDS_LOGIN',
      message: 'Trzeba zalogowac konto Google w otwartym oknie Chrome.',
      url,
      title,
      checkedAt,
    };
  }

  if (normalizedUrl.includes('chat.google.com')) {
    return {
      state: 'ACTIVE',
      message: 'Sesja Google Chat wyglada na aktywna.',
      url,
      title,
      checkedAt,
    };
  }

  return {
    state: 'UNKNOWN',
    message: 'Nie udalo sie jednoznacznie sprawdzic sesji. Sprawdz otwarte okno Chrome.',
    url,
    title,
    checkedAt,
  };
}

async function readChromeSessionStatus(
  config: ChatInviteBrowserConfig,
  debug: ChatInviteDebugInfo,
): Promise<ChatInviteSessionStatus> {
  const cdpUrl = await waitForCdpEndpoint(config, debug);
  const listUrl = `${cdpUrl}/json/list`;
  const startedAt = Date.now();
  let lastTarget: ChromeTargetInfo | null = null;
  let activeTarget: ChromeTargetInfo | null = null;

  while (Date.now() - startedAt < 8_000) {
    try {
      const response = await fetch(listUrl);
      if (response.ok) {
        const targets = (await response.json()) as ChromeTargetInfo[];
        lastTarget =
          targets.find((target) => target.type === 'page' && target.url?.includes('accounts.google.com')) ??
          targets.find((target) => target.type === 'page' && target.url?.includes('chat.google.com')) ??
          targets.find((target) => target.type === 'page') ??
          null;
        const status = sessionStatusFromTarget(lastTarget);
        if (status.state === 'NEEDS_LOGIN') return status;
        if (status.state === 'ACTIVE') activeTarget = lastTarget;
        if (activeTarget && Date.now() - startedAt > 3_000) return sessionStatusFromTarget(activeTarget);
      }
    } catch {
      // Chrome target list is not ready yet.
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 500));
  }

  return sessionStatusFromTarget(lastTarget);
}

function inviteKey(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function firstEmail(text: string): string | null {
  return text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}(?=$|[^a-z0-9.-])/i)?.[0] ?? null;
}

function stripInviteActionText(text: string): string {
  return text
    .replace(/(?:Podgl(?:\u0105d|ad)|Preview)\s*(?:Do(?:\u0142\u0105cz|lacz)|Join)?\s*$/i, '')
    .replace(/(?:Do(?:\u0142\u0105cz|lacz)|Join)\s*$/i, '')
    .trim();
}

function compactInviteText(text: string): string {
  return stripInviteActionText(text.replace(/\s+/g, ' '));
}

function indexOfNormalized(haystack: string, needle: string): number {
  return normalizePolishText(haystack).indexOf(normalizePolishText(needle));
}

function emailAfterInviteMarker(text: string): string | null {
  const compactText = compactInviteText(text);
  const markerIndex = indexOfNormalized(compactText, 'Zaproszenie od:');
  const source = stripInviteActionText(markerIndex >= 0 ? compactText.slice(markerIndex) : compactText);
  return firstEmail(source);
}

function trimRoomName(text: string): string {
  const compactText = compactInviteText(text)
    .replace(/\s+z\s+zewnatrz\s*[•-]?\s*$/i, '')
    .trim();
  const userCountMatch = normalizePolishText(compactText).match(/\s+\d+\s+uzytkownikow/);
  if (userCountMatch?.index === undefined || userCountMatch.index < 1) return compactText;
  return compactText.slice(0, userCountMatch.index).trim();
}

function firstUsefulLine(text: string): string | null {
  const compactText = compactInviteText(text);
  const inviteMarkerIndex = indexOfNormalized(compactText, 'Zaproszenie od:');
  if (inviteMarkerIndex > 0) {
    return trimRoomName(compactText.slice(0, inviteMarkerIndex));
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(dolacz|join)$/i.test(normalizePolishText(line)));
  return lines[0] ?? null;
}

export function mapRawInviteCandidates(rawCandidates: RawInviteCandidate[]): ChatInviteCandidate[] {
  return rawCandidates.map((candidate) => {
    const senderEmail = emailAfterInviteMarker(candidate.text);
    return {
      key: inviteKey(candidate.text),
      roomName: firstUsefulLine(candidate.text),
      senderEmail,
      textPreview: compactInviteText(candidate.text).slice(0, 500),
    };
  });
}

async function openInvitesPage(
  config: ChatInviteBrowserConfig,
  debug: ChatInviteDebugInfo,
): Promise<{ page: Page; close: () => Promise<void> }> {
  debug.steps.push(`Tworze/uzywam profilu Chrome: ${config.profileDir}`);
  await mkdir(config.profileDir, { recursive: true });
  launchExternalChrome(config, debug);
  const cdpUrl = await waitForCdpEndpoint(config, debug);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20_000);
  debug.steps.push(`Otwieram ${GOOGLE_CHAT_INVITES_URL}`);
  await page.goto(GOOGLE_CHAT_INVITES_URL, { waitUntil: 'domcontentloaded' });
  debug.steps.push('DOM zaladowany, czekam 3s na dane Google Chat');
  await page.waitForTimeout(3_000);
  debug.finalUrl = page.url();
  debug.title = await page.title().catch(() => null);

  return {
    page,
    close: async () => browser.close(),
  };
}

async function collectPageDebug(page: Page): Promise<Omit<ChatInviteDebugInfo, 'steps' | 'error' | 'rawCandidateCount'>> {
  return page.evaluate(() => {
    const normalizeLabel = (value: string): string =>
      value
        .normalize('NFKD')
        .replace(/[łŁ]/g, 'l')
        .replace(/[ąĄ]/g, 'a')
        .replace(/[ćĆ]/g, 'c')
        .replace(/[ęĘ]/g, 'e')
        .replace(/[ńŃ]/g, 'n')
        .replace(/[óÓ]/g, 'o')
        .replace(/[śŚ]/g, 's')
        .replace(/[źŹżŻ]/g, 'z')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const buttonLabels = buttons.map((button) =>
      [
        button.textContent ?? '',
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('data-tooltip') ?? '',
      ]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    const joinButtonCount = buttonLabels.filter((label) => /\b(dolacz|join)\b/i.test(normalizeLabel(label))).length;
    return {
      finalUrl: window.location.href,
      title: document.title,
      buttonCount: buttons.length,
      joinButtonCount,
      bodyTextPreview: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      buttonLabelsPreview: buttonLabels.filter(Boolean).slice(0, 30),
    };
  });
}

async function extractRawInviteCandidates(page: Page): Promise<RawInviteCandidate[]> {
  return page.evaluate(() => {
    const normalizeLabel = (value: string): string =>
      value
        .normalize('NFKD')
        .replace(/[łŁ]/g, 'l')
        .replace(/[ąĄ]/g, 'a')
        .replace(/[ćĆ]/g, 'c')
        .replace(/[ęĘ]/g, 'e')
        .replace(/[ńŃ]/g, 'n')
        .replace(/[óÓ]/g, 'o')
        .replace(/[śŚ]/g, 's')
        .replace(/[źŹżŻ]/g, 'z')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const joinButtons = buttons.filter((button) => {
      const label = [
        button.textContent ?? '',
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('data-tooltip') ?? '',
      ].join(' ');
      return /\b(dolacz|join)\b/i.test(normalizeLabel(label));
    });

    return joinButtons.map((button, buttonIndex) => {
      let container: Element | null = button;
      for (let depth = 0; depth < 8 && container?.parentElement; depth += 1) {
        const parentText = container.parentElement.textContent?.trim() ?? '';
        if (parentText.length > 80) {
          container = container.parentElement;
          break;
        }
        container = container.parentElement;
      }

      return {
        buttonIndex,
        text: (container?.textContent ?? button.textContent ?? '').trim(),
      };
    });
  });
}

async function clickJoinButton(page: Page, inviteIndex: number): Promise<boolean> {
  return page.evaluate((targetIndex) => {
    const normalizeLabel = (value: string): string =>
      value
        .normalize('NFKD')
        .replace(/[\u0142\u0141]/g, 'l')
        .replace(/[\u0105\u0104]/g, 'a')
        .replace(/[\u0107\u0106]/g, 'c')
        .replace(/[\u0119\u0118]/g, 'e')
        .replace(/[\u0144\u0143]/g, 'n')
        .replace(/[\u00f3\u00d3]/g, 'o')
        .replace(/[\u015b\u015a]/g, 's')
        .replace(/[\u017a\u0179\u017c\u017b]/g, 'z')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const joinButtons = buttons.filter((button) => {
      const label = [
        button.textContent ?? '',
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('data-tooltip') ?? '',
      ].join(' ');
      return /\b(dolacz|join)\b/i.test(normalizeLabel(label));
    });
    const target = joinButtons[targetIndex];
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, inviteIndex);
}

export async function listChatInvites(input: {
  config: ChatInviteBrowserConfig;
}): Promise<{
  invites: ChatInviteCandidate[];
  url: string;
  profileDir: string;
  session: ChatInviteSessionStatus;
  launch: ChatInviteBrowserLaunchInfo;
}> {
  const debug = createDebugInfo();
  const browser = await openInvitesPage(input.config, debug);
  try {
    const pageDebug = await collectPageDebug(browser.page);
    Object.assign(debug, pageDebug);
    const session = sessionStatusFromTarget({
      url: debug.finalUrl ?? undefined,
      title: debug.title ?? undefined,
      type: 'page',
    });
    const rawCandidates = await extractRawInviteCandidates(browser.page);
    debug.rawCandidateCount = rawCandidates.length;
    debug.steps.push(`Znaleziono kandydatow zaproszen: ${rawCandidates.length}`);
    return {
      invites: mapRawInviteCandidates(rawCandidates),
      url: GOOGLE_CHAT_INVITES_URL,
      profileDir: input.config.profileDir,
      session,
      launch: buildInviteBrowserLaunchInfo({
        config: input.config,
        executablePath: findBrowserExecutable(),
      }),
    };
  } catch (error) {
    debug.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await browser.close();
  }
}

export async function acceptChatInvite(input: {
  config: ChatInviteBrowserConfig;
  inviteKey: string;
}): Promise<{ accepted: boolean; invite: ChatInviteCandidate | null }> {
  const debug = createDebugInfo();
  const browser = await openInvitesPage(input.config, debug);
  try {
    const pageDebug = await collectPageDebug(browser.page);
    Object.assign(debug, pageDebug);
    const rawCandidates = await extractRawInviteCandidates(browser.page);
    debug.rawCandidateCount = rawCandidates.length;
    const invites = mapRawInviteCandidates(rawCandidates);
    const inviteIndex = invites.findIndex((invite) => invite.key === input.inviteKey);
    const invite = inviteIndex >= 0 ? invites[inviteIndex] : null;
    if (!invite) return { accepted: false, invite };

    debug.steps.push(`Klikam Dolacz dla zaproszenia ${invite.key} na pozycji ${inviteIndex}`);
    const clicked = await clickJoinButton(browser.page, inviteIndex);
    if (!clicked) {
      throw new Error(`Nie znaleziono przycisku Dolacz dla zaproszenia ${invite.key}`);
    }
    await browser.page.waitForTimeout(2_000);
    return { accepted: true, invite };
  } catch (error) {
    debug.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await browser.close();
  }
}

export function defaultInviteProfileDir(): string {
  return resolve(dirname(process.env.PHOTO_LOCAL_DB ?? './data/photo-local.sqlite'), 'google-chat-browser-profile');
}

export async function openChatInvitesSetup(input: {
  config: ChatInviteBrowserConfig;
}): Promise<{
  started: boolean;
  url: string;
  profileDir: string;
  session: ChatInviteSessionStatus;
  launch: ChatInviteBrowserLaunchInfo;
  error: string | null;
  diagnostics: string[];
}> {
  const debug = createDebugInfo();
  let launch = buildInviteBrowserLaunchInfo({
    config: input.config,
    executablePath: findBrowserExecutable(),
  });
  debug.steps.push(`Tworze/uzywam profilu Chrome: ${input.config.profileDir}`);
  await mkdir(input.config.profileDir, { recursive: true });
  debug.steps.push('Otwieram launcher logowania Google Chat i zostawiam okno otwarte');
  try {
    const visibleConfig = { ...input.config, headless: false };
    if (input.config.launcherPath) {
      launchLoginLauncher(input.config.launcherPath, debug);
    } else {
      launch = launchExternalChrome(visibleConfig, debug);
    }
    const session = await readChromeSessionStatus(visibleConfig, debug);

    return {
      started: true,
      url: GOOGLE_CHAT_INVITES_URL,
      profileDir: input.config.profileDir,
      session,
      launch,
      error: null,
      diagnostics: debug.steps,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error = message;
    return {
      started: false,
      url: GOOGLE_CHAT_INVITES_URL,
      profileDir: input.config.profileDir,
      session: {
        state: 'UNKNOWN',
        message: `Nie udalo sie automatycznie otworzyc przegladarki: ${message}`,
        url: null,
        title: null,
        checkedAt: new Date().toISOString(),
      },
      launch,
      error: message,
      diagnostics: debug.steps,
    };
  }
}

