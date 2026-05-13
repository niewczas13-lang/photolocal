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
  allowed: boolean;
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
}

interface RawInviteCandidate {
  buttonIndex: number;
  text: string;
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

function chromeCandidates(): string[] {
  return [
    process.env.GOOGLE_CHROME_PATH ?? '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
}

function findChromeExecutable(): string {
  const chromePath = chromeCandidates().find((candidate) => existsSync(candidate));
  if (!chromePath) {
    throw new Error('Nie znaleziono chrome.exe. Ustaw GOOGLE_CHROME_PATH w .env.');
  }
  return chromePath;
}

function launchExternalChrome(config: ChatInviteBrowserConfig, debug: ChatInviteDebugInfo): void {
  const chromePath = findChromeExecutable();
  const debugPort = inviteDebugPort(config);
  debug.steps.push(`Uruchamiam zwykly Chrome: ${chromePath}`);
  debug.steps.push(`Remote debugging port: ${debugPort}`);

  const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${config.profileDir}`,
      '--no-first-run',
    ...(config.headless ? ['--headless=new', '--disable-gpu'] : ['--new-window']),
    GOOGLE_CHAT_INVITES_URL,
  ];

  const child = spawn(
    chromePath,
    args,
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: config.headless,
    },
  );
  child.unref();
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

export function parseInviteWhitelist(value: string): string[] {
  return value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isInviteSenderAllowed(senderEmail: string | null, whitelist: string[]): boolean {
  if (!senderEmail) return false;
  const email = senderEmail.toLowerCase();
  const domain = email.split('@')[1] ?? '';

  return whitelist.some((entry) => {
    const normalized = entry.toLowerCase();
    if (normalized === email) return true;
    if (normalized === `*@${domain}` || normalized === `@${domain}` || normalized === domain) return true;
    return normalized.startsWith('*.') && domain.endsWith(normalized.slice(2));
  });
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

export function mapRawInviteCandidates(rawCandidates: RawInviteCandidate[], whitelistText: string): ChatInviteCandidate[] {
  const whitelist = parseInviteWhitelist(whitelistText);
  return rawCandidates.map((candidate) => {
    const senderEmail = emailAfterInviteMarker(candidate.text);
    return {
      key: inviteKey(candidate.text),
      roomName: firstUsefulLine(candidate.text),
      senderEmail,
      textPreview: compactInviteText(candidate.text).slice(0, 500),
      allowed: isInviteSenderAllowed(senderEmail, whitelist),
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
  whitelist: string;
}): Promise<{ invites: ChatInviteCandidate[]; url: string; profileDir: string; debug: ChatInviteDebugInfo }> {
  const debug = createDebugInfo();
  const browser = await openInvitesPage(input.config, debug);
  try {
    const pageDebug = await collectPageDebug(browser.page);
    Object.assign(debug, pageDebug);
    const rawCandidates = await extractRawInviteCandidates(browser.page);
    debug.rawCandidateCount = rawCandidates.length;
    debug.steps.push(`Znaleziono kandydatow zaproszen: ${rawCandidates.length}`);
    return {
      invites: mapRawInviteCandidates(rawCandidates, input.whitelist),
      url: GOOGLE_CHAT_INVITES_URL,
      profileDir: input.config.profileDir,
      debug,
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
  whitelist: string;
  inviteKey: string;
}): Promise<{ accepted: boolean; invite: ChatInviteCandidate | null; debug: ChatInviteDebugInfo }> {
  const debug = createDebugInfo();
  const browser = await openInvitesPage(input.config, debug);
  try {
    const pageDebug = await collectPageDebug(browser.page);
    Object.assign(debug, pageDebug);
    const rawCandidates = await extractRawInviteCandidates(browser.page);
    debug.rawCandidateCount = rawCandidates.length;
    const invites = mapRawInviteCandidates(rawCandidates, input.whitelist);
    const inviteIndex = invites.findIndex((invite) => invite.key === input.inviteKey);
    const invite = inviteIndex >= 0 ? invites[inviteIndex] : null;
    if (!invite || !invite.allowed) return { accepted: false, invite, debug };

    debug.steps.push(`Klikam Dolacz dla zaproszenia ${invite.key} na pozycji ${inviteIndex}`);
    const clicked = await clickJoinButton(browser.page, inviteIndex);
    if (!clicked) {
      throw new Error(`Nie znaleziono przycisku Dolacz dla zaproszenia ${invite.key}`);
    }
    await browser.page.waitForTimeout(2_000);
    return { accepted: true, invite, debug };
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
}): Promise<{ started: true; url: string; profileDir: string; debug: ChatInviteDebugInfo }> {
  const debug = createDebugInfo();
  debug.steps.push(`Tworze/uzywam profilu Chrome: ${input.config.profileDir}`);
  await mkdir(input.config.profileDir, { recursive: true });
  debug.steps.push('Otwieram zwykly Chrome do logowania i zostawiam okno otwarte');
  launchExternalChrome({ ...input.config, headless: false }, debug);

  return {
    started: true,
    url: GOOGLE_CHAT_INVITES_URL,
    profileDir: input.config.profileDir,
    debug,
  };
}

