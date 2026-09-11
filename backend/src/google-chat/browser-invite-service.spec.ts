import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserInviteService, type BrowserInviteAdapter } from './browser-invite-service.js';

const candidate = { fingerprint: 'exact-card', roomName: 'Room A', senderEmail: 'sender@example.test', textPreview: 'Room A invitation', spaceName: 'spaces/AAAA', canAccept: true };
function setup() {
  const adapter: BrowserInviteAdapter = {
    list: vi.fn(async () => ({ invites: [candidate], state: 'ACTIVE' as const })),
    accept: vi.fn(async () => ({ spaceName: 'spaces/AAAA' })),
  };
  const spaces = vi.fn(async () => [] as Array<{ name: string }>);
  const service = new BrowserInviteService(adapter, spaces, { wait: async () => undefined });
  return { service, adapter, spaces };
}
afterEach(() => vi.useRealTimers());

describe('private browser invite service', () => {
  it('bounds API confirmation and releases the browser lock even if an upstream promise stalls', async () => {
    vi.useFakeTimers();
    const { service, spaces } = setup();
    spaces.mockImplementation(() => new Promise(() => undefined));
    const listed = await service.list('owner-a');
    const accepting = service.accept('owner-a', listed.invites[0].key);
    const assertion = expect(accepting).rejects.toMatchObject({ code: 'INVITE_ACCOUNT_UNCONFIRMED' });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(service.startLogin('owner-a').sessionId).toBeTruthy();
    service.close();
  });
  it('releases an abandoned HTTP start if no websocket attaches within thirty seconds', () => {
    vi.useFakeTimers();
    const { service } = setup();
    const abandoned = service.startLogin('owner-a');
    vi.advanceTimersByTime(30_001);
    expect(() => service.assertLogin('owner-a', abandoned.sessionId)).toThrow();
    expect(service.startLogin('owner-b').sessionId).toBeTruthy();
    service.close();
  });
  it('starts a bounded opaque login lease without attaching a browser; excludes all operations', async () => {
    const { service, adapter } = setup();
    const lease = service.startLogin('owner-a');
    expect(lease.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(lease.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
    expect(lease.websocketPath).toBe(`/api/google-chat/invites/browser/${lease.sessionId}/socket`);
    expect(adapter.list).not.toHaveBeenCalled();
    expect(() => service.startLogin('owner-b')).toThrow('Zakończ');
    await expect(service.list('owner-a')).rejects.toMatchObject({ code: 'BROWSER_BUSY' });
    expect(() => service.claimLogin('owner-b', lease.sessionId, vi.fn())).toThrow();
    service.close();
  });

  it('allows only one socket and releases it on expiry, explicit release or owner logout', () => {
    vi.useFakeTimers();
    const { service } = setup();
    const lease = service.startLogin('owner-a');
    const close = vi.fn();
    service.claimLogin('owner-a', lease.sessionId, close);
    expect(() => service.claimLogin('owner-a', lease.sessionId, vi.fn())).toThrow();
    expect(() => service.releaseLogin('owner-b', lease.sessionId)).toThrow();
    vi.advanceTimersByTime(600_001);
    expect(close).toHaveBeenCalledOnce();
    expect(() => service.assertLogin('owner-a', lease.sessionId)).toThrow();
    const next = service.startLogin('owner-a');
    service.claimLogin('owner-a', next.sessionId, close);
    service.releaseOwner('owner-a');
    expect(close).toHaveBeenCalledTimes(2);
    service.close();
  });

  it('makes DELETE after socket close idempotent, but never releases another owner', () => {
    const { service } = setup();
    const lease = service.startLogin('owner-a');
    expect(() => service.releaseLogin('owner-b', lease.sessionId)).toThrow();
    service.releaseLogin('owner-a', lease.sessionId);
    expect(() => service.releaseLogin('owner-a', lease.sessionId)).not.toThrow();
    service.close();
  });

  it('requires a fresh invite listed to the same owner and never accepts during discovery', async () => {
    const { service, adapter } = setup();
    const listed = await service.list('owner-a');
    expect(adapter.accept).not.toHaveBeenCalled();
    expect(listed.invites[0].key).not.toContain(candidate.fingerprint);
    await expect(service.accept('owner-b', listed.invites[0].key)).rejects.toMatchObject({ code: 'INVITE_NOT_LISTED' });
    await expect(service.accept('owner-a', 'made-up')).rejects.toMatchObject({ code: 'INVITE_NOT_LISTED' });
    expect(adapter.accept).not.toHaveBeenCalled();
    service.close();
  });

  it('reports acceptance only after the exact newly joined API room is visible', async () => {
    const { service, spaces, adapter } = setup();
    spaces.mockResolvedValueOnce([]).mockResolvedValueOnce([{ name: 'spaces/OTHER' }]).mockResolvedValueOnce([{ name: 'spaces/AAAA' }]);
    const listed = await service.list('owner-a');
    const result = await service.accept('owner-a', listed.invites[0].key);
    expect(result.accepted).toBe(true);
    expect(adapter.accept).toHaveBeenCalledWith(candidate);
    expect(spaces).toHaveBeenCalledTimes(3);
    await expect(service.accept('owner-a', listed.invites[0].key)).rejects.toMatchObject({ code: 'INVITE_NOT_LISTED' });
    service.close();
  });

  it('does not claim success for elapsed time, another room or preexisting API membership', async () => {
    const { service, spaces } = setup();
    spaces.mockResolvedValue([{ name: 'spaces/OTHER' }]);
    const listed = await service.list('owner-a');
    await expect(service.accept('owner-a', listed.invites[0].key)).rejects.toMatchObject({ code: 'INVITE_ACCEPTANCE_UNCONFIRMED' });
    const second = await service.list('owner-a');
    spaces.mockResolvedValue([{ name: 'spaces/AAAA' }]);
    await expect(service.accept('owner-a', second.invites[0].key)).rejects.toMatchObject({ code: 'INVITE_ACCOUNT_UNCONFIRMED' });
    service.close();
  });

  it('rejects ambiguous or unidentifiable invitations before clicking', async () => {
    const { service, adapter } = setup();
    vi.mocked(adapter.list).mockResolvedValue({ state: 'ACTIVE', invites: [{ ...candidate, canAccept: false }] });
    const listed = await service.list('owner-a');
    await expect(service.accept('owner-a', listed.invites[0].key)).rejects.toMatchObject({ code: 'INVITE_ID_UNAVAILABLE' });
    expect(adapter.accept).not.toHaveBeenCalled();
    service.close();
  });

  it('holds mutual exclusion during asynchronous discovery and releases it after failure', async () => {
    const { service, adapter } = setup();
    let reject: (reason: unknown) => void = () => undefined;
    vi.mocked(adapter.list).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = service.list('owner-a');
    expect(() => service.startLogin('owner-a')).toThrow();
    await expect(service.list('owner-b')).rejects.toMatchObject({ code: 'BROWSER_BUSY' });
    reject(new Error('private upstream diagnostics'));
    await expect(pending).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' });
    expect(service.startLogin('owner-a').sessionId).toBeTruthy();
    service.close();
  });
});
