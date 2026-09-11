export interface BrowserInviteDomCard {
  fingerprint: string; text: string; spaceName: string | null;
  action: 'join' | 'view'; canAccept: boolean;
}

/** Self-contained for Playwright evaluate: discovery is read-only unless an exact identity is supplied. */
export function inspectBrowserInviteDom(input?: { fingerprint: string; action: 'join' | 'view' } | void): {
  cards: BrowserInviteDomCard[]; clicked: boolean; spaceName: string | null; screenState: 'INVITES' | 'EMPTY' | 'UNKNOWN';
} {
  const normalize = (value: string) => value.normalize('NFKD').replace(/[łŁ]/g, 'l').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (element: Element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = document.defaultView?.getComputedStyle?.(node);
      const inline = (node as HTMLElement).style;
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
        || inline?.display === 'none' || inline?.visibility === 'hidden' || inline?.visibility === 'collapse') return false;
    }
    return true;
  };
  const action = (button: Element): 'join' | 'view' | null => {
    if (!visible(button) || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') return null;
    const labels = [button.textContent ?? '', button.getAttribute('aria-label') ?? '', button.getAttribute('data-tooltip') ?? ''].map(normalize);
    if (labels.some(label => /^(join(?: space| room)?|dolacz(?: do (?:czatu|pokoju|grupy))?)$/.test(label))) return 'join';
    if (labels.some(label => /^(view|preview|wyswietl|podglad)$/.test(label))) return 'view';
    return null;
  };
  const spaceFrom = (value: string): string | null => {
    try {
      const url = new URL(value, 'https://chat.google.com');
      if (url.protocol !== 'https:' || url.hostname !== 'chat.google.com') return null;
      const id = url.pathname.match(/\/(?:room|space)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
      return id ? `spaces/${id}` : null;
    } catch { return null; }
  };
  const rows = new Map<Element, { element: Element; buttons: Element[]; card: BrowserInviteDomCard }>();
  for (const button of Array.from(document.querySelectorAll('button, [role="button"]'))) {
    if (!action(button)) continue;
    let row = button.parentElement;
    for (let depth = 0; row && depth < 8; depth++, row = row.parentElement) {
      if (row === document.body || row === document.documentElement) break;
      const text = ((row as HTMLElement).innerText ?? row.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!/(?:zaproszenie|invitation|invited by)/.test(normalize(text))) continue;
      const buttons = Array.from(row.querySelectorAll('button, [role="button"]')).filter(item => action(item));
      if (text.length > 4000 || buttons.length > 2) break;
      const ids = new Set(Array.from(row.querySelectorAll('a[href]')).map(anchor => spaceFrom(anchor.getAttribute('href') ?? '')).filter((id): id is string => id !== null));
      for (const element of [row, ...Array.from(row.querySelectorAll('[data-space-id], [data-room-id]'))]) {
        const id = element.getAttribute('data-space-id') ?? element.getAttribute('data-room-id');
        if (id && /^(?:spaces\/)?[A-Za-z0-9_-]+$/.test(id)) ids.add(id.startsWith('spaces/') ? id : `spaces/${id}`);
      }
      const spaceName = ids.size === 1 ? [...ids][0] : null;
      const preferred = buttons.find(item => action(item) === (spaceName ? 'join' : 'view')) ?? buttons[0];
      const chosen = action(preferred);
      if (!chosen) break;
      rows.set(row, { element: row, buttons, card: { fingerprint: JSON.stringify([spaceName, text]), text,
        spaceName, action: chosen, canAccept: ids.size <= 1 && (spaceName !== null || chosen === 'view') } });
      break;
    }
  }
  const allRows = [...rows.values()];
  const found = allRows.filter(row => !allRows.some(other => other !== row && row.element.contains(other.element)));
  for (const row of found) {
    if (found.filter(other => other.card.fingerprint === row.card.fingerprint).length !== 1) row.card.canAccept = false;
  }
  let clicked = false;
  let spaceName: string | null = null;
  if (input) {
    const matches = found.filter(row => row.card.fingerprint === input.fingerprint && row.card.canAccept);
    if (matches.length === 1 && matches[0].card.action === input.action) {
      const row = matches[0];
      const buttons = row.buttons.filter(button => action(button) === input.action);
      if (buttons.length === 1 && (input.action === 'view' || row.card.spaceName)) {
        (buttons[0] as HTMLElement).click();
        clicked = true; spaceName = row.card.spaceName;
      }
    }
  }
  const body = normalize(document.body?.innerText ?? document.body?.textContent ?? '');
  const empty = /(?:no invitations|you have no invitations|no spaces found|brak zaproszen|nie masz (?:zadnych )?zaproszen|nie znaleziono pokoi)/.test(body);
  return { cards: found.map(row => row.card), clicked, spaceName, screenState: found.length ? 'INVITES' : empty ? 'EMPTY' : 'UNKNOWN' };
}

/** A preview may expose the room ID. Never use an arbitrary page-wide Join button. */
export function clickBrowserPreviewJoin(input: { roomName: string | null; expectedSpaceName: string | null }): {
  clicked: boolean; spaceName: string | null;
} {
  const normalize = (value: string) => value.normalize('NFKD').replace(/[łŁ]/g, 'l').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const spaceFrom = (value: string): string | null => {
    try {
      const url = new URL(value, 'https://chat.google.com');
      if (url.protocol !== 'https:' || url.hostname !== 'chat.google.com') return null;
      const id = url.pathname.match(/\/(?:room|space)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
      return id ? `spaces/${id}` : null;
    } catch { return null; }
  };
  const visible = (element: Element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = document.defaultView?.getComputedStyle?.(node);
      const inline = (node as HTMLElement).style;
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
        || inline?.display === 'none' || inline?.visibility === 'hidden' || inline?.visibility === 'collapse') return false;
    }
    return true;
  };
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
  const currentSpace = spaceFrom(location.href);
  const scopes = dialogs.length ? dialogs : currentSpace ? [document.body] : [];
  const eligible: Array<{ button: HTMLElement; spaceName: string }> = [];
  for (const scope of scopes) {
    const headings = Array.from(scope.querySelectorAll('h1, h2, [role="heading"]'));
    if (!input.roomName || !headings.some(heading => normalize(heading.textContent ?? '') === normalize(input.roomName!))) continue;
    const ids = new Set(Array.from(scope.querySelectorAll('a[href]')).map(link => spaceFrom(link.getAttribute('href') ?? '')).filter((id): id is string => id !== null));
    if (!dialogs.length && currentSpace) ids.add(currentSpace);
    if (ids.size !== 1) continue;
    const spaceName = [...ids][0];
    if (input.expectedSpaceName && input.expectedSpaceName !== spaceName) continue;
    const buttons = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(visible).filter(button => {
      if (button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') return false;
      return [button.textContent ?? '', button.getAttribute('aria-label') ?? ''].map(normalize)
        .some(label => /^(join(?: space| room)?|dolacz(?: do (?:czatu|pokoju|grupy))?)$/.test(label));
    });
    if (buttons.length === 1) eligible.push({ button: buttons[0] as HTMLElement, spaceName });
  }
  if (eligible.length !== 1) return { clicked: false, spaceName: null };
  eligible[0].button.click();
  return { clicked: true, spaceName: eligible[0].spaceName };
}
