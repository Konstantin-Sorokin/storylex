import type { AccountRepository } from '../data/account-repository.ts';
import { parsePage, parseReceipts, parseSession } from '../domain/sync.ts';

export class SyncHttpError extends Error {
  readonly retryAfter: number | null;
  constructor(status: number, retryAfter: number | null) {
    super(status === 401 ? 'Для sync введите dev-токен снова. Локальный прогресс сохранён.' : `Sync HTTP ${status}. Очередь сохранена.`);
    this.retryAfter = retryAfter;
  }
}
export async function syncRequest(base: string, path: string, token: string, fetcher: typeof fetch, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetcher(new URL(path, base.endsWith('/') ? base : base + '/'), {
    method: body === undefined ? 'GET' : 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const retry = response.headers.get('Retry-After');
    const delay = retry === null ? null : /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
    throw new SyncHttpError(response.status, delay !== null && Number.isFinite(delay) ? delay : null);
  }
  return response.json();
}
export async function devSession(base: string, token: string, fetcher: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try { return parseSession(await syncRequest(base, 'dev/session', token, fetcher, controller.signal)); }
  finally { clearTimeout(timeout); }
}

export class SyncCoordinator {
  private readonly repository: AccountRepository;
  private readonly base: string;
  private readonly token: () => string;
  private readonly changed: () => void;
  private readonly fetcher: typeof fetch;
  private running: Promise<void> | null = null;
  private closed = false;
  private controller: AbortController | null = null;
  private requested = false;
  constructor(repository: AccountRepository, base: string, token: () => string, changed = () => {}, fetcher: typeof fetch = fetch) {
    this.repository = repository; this.base = base; this.token = token; this.changed = changed; this.fetcher = fetcher;
  }
  async stop(): Promise<void> { this.closed = true; this.controller?.abort(); await this.running?.catch(() => {}); }
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) { this.requested = true; return this.running; }
    this.running = (async () => {
      do { this.requested = false; await this.cycle(); } while (this.requested && !this.closed);
    })().finally(() => { this.running = null; this.changed(); });
    return this.running;
  }
  private async cycle(): Promise<void> {
    const token = this.token();
    if (!token) throw new Error('Введите dev-токен для отправки. Офлайн-прогресс сохранён.');
    const active = () => !this.closed && this.token() === token;
    const request = async (path: string, body?: unknown) => {
      if (!active()) throw new Error('Контекст аккаунта закрыт.');
      const controller = new AbortController(); this.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 15000);
      try { return await syncRequest(this.base, path, token, this.fetcher, controller.signal, body); }
      finally { clearTimeout(timeout); this.controller = null; }
    };
    const userId = parseSession(await request('dev/session'));
    if (userId !== this.repository.userId) throw new Error('Dev-токен другого аккаунта. Очередь не отправлена.');
    while (active()) {
      const operations = await this.repository.pending();
      if (operations.length === 0) break;
      const receipts = parseReceipts(await request('sync/operations', { device_id: this.repository.deviceId, operations }));
      await this.repository.acknowledge(operations, receipts, active);
    }
    let through: string | null = null;
    while (active()) {
      const after = await this.repository.cursor();
      const page = parsePage(await request(`sync/changes?after=${after}${through === null ? '' : '&through_cursor=' + through}`));
      await this.repository.applyPage(page, after, through, active);
      through = page.through_cursor;
      if (!page.has_more) break;
    }
    await this.repository.finish(active);
  }
}
