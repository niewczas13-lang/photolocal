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

export interface ChatInviteBrowserConfig {
  profileDir: string;
  headless: boolean;
}

interface RawInviteCandidate {
  buttonIndex: number;
  text: string;
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

async function openInvitesPage(config: ChatInviteBrowserConfig): Promise<{ page: Page; close: () => Promise<void> }> {
  await mkdir(config.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(config.profileDir, {
    channel: 'chrome',
    headless: config.headless,
    viewport: { width: 1400, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20_000);
  await page.goto(GOOGLE_CHAT_INVITES_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);

  return {
    page,
    close: async () => context.close(),
  };
}

async function extractRawInviteCandidates(page: Page): Promise<RawInviteCandidate[]> {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const joinButtons = buttons.filter((button) => {
      const label = [
        button.textContent ?? '',
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('data-tooltip') ?? '',
      ].join(' ');
      return /\b(dołącz|dolacz|join)\b/i.test(label);
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
}): Promise<{ invites: ChatInviteCandidate[]; url: string; profileDir: string }> {
  const browser = await openInvitesPage(input.config);
  try {
    const rawCandidates = await extractRawInviteCandidates(browser.page);
    return {
      invites: mapRawInviteCandidates(rawCandidates, input.whitelist),
      url: GOOGLE_CHAT_INVITES_URL,
      profileDir: input.config.profileDir,
    };
  } finally {
    await browser.close();
  }
}

export async function acceptChatInvite(input: {
  config: ChatInviteBrowserConfig;
  whitelist: string;
  inviteKey: string;
}): Promise<{ accepted: boolean; invite: ChatInviteCandidate | null }> {
  const browser = await openInvitesPage(input.config);
  try {
    const rawCandidates = await extractRawInviteCandidates(browser.page);
    const invites = mapRawInviteCandidates(rawCandidates, input.whitelist);
    const inviteIndex = invites.findIndex((invite) => invite.key === input.inviteKey);
    const invite = inviteIndex >= 0 ? invites[inviteIndex] : null;
    if (!invite || !invite.allowed) return { accepted: false, invite };

    await browser.page.getByRole('button', { name: /dołącz|dolacz|join/i }).nth(inviteIndex).click();
    await browser.page.waitForTimeout(2_000);
    return { accepted: true, invite };
  } finally {
    await browser.close();
  }
}

export function defaultInviteProfileDir(): string {
  return resolve(dirname(process.env.PHOTO_LOCAL_DB ?? './data/photo-local.sqlite'), 'google-chat-browser-profile');
}
