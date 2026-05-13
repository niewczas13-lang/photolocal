import { createHash } from 'node:crypto';
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
}

interface RawInviteCandidate {
  buttonIndex: number;
  text: string;
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
  return text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] ?? null;
}

function firstUsefulLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(dołącz|dolacz|join)$/i.test(line));
  return lines[0] ?? null;
}

export function mapRawInviteCandidates(rawCandidates: RawInviteCandidate[], whitelistText: string): ChatInviteCandidate[] {
  const whitelist = parseInviteWhitelist(whitelistText);
  return rawCandidates.map((candidate) => {
    const senderEmail = firstEmail(candidate.text);
    return {
      key: inviteKey(candidate.text),
      roomName: firstUsefulLine(candidate.text),
      senderEmail,
      textPreview: candidate.text.replace(/\s+/g, ' ').trim().slice(0, 500),
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
  debug.steps.push(`Uruchamiam Chrome: ${config.headless ? 'headless' : 'widoczny'}`);
  const context = await chromium.launchPersistentContext(config.profileDir, {
    channel: 'chrome',
    headless: config.headless,
    viewport: { width: 1400, height: 900 },
  });
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
    close: async () => context.close(),
  };
}

async function collectPageDebug(page: Page): Promise<Omit<ChatInviteDebugInfo, 'steps' | 'error' | 'rawCandidateCount'>> {
  return page.evaluate(() => {
    const normalizeLabel = (value: string): string =>
      value
        .normalize('NFKD')
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

    debug.steps.push(`Klikam Dolacz dla zaproszenia ${invite.key}`);
    await browser.page.getByRole('button', { name: /dołącz|dolacz|join/i }).nth(inviteIndex).click();
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
