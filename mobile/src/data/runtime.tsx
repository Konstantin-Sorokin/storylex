import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, AppState, TextInput } from 'react-native';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { ContentRepository } from './content-repository.ts';
import { migrate } from './database.ts';
import { openContentDatabase, openLocalDatabase } from './expo-database.ts';
import { AccountRepository, migrateAccount } from './account-repository.ts';
import { devSession, SyncCoordinator, SyncHttpError } from '../infrastructure/sync.ts';
import { ContentDownloader } from '../infrastructure/downloader.ts';
import { Action, Copy, Heading, Page } from '../ui/common.tsx';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8000/api/v1/';
type Runtime = { repository: ContentRepository; learning: AccountRepository; downloader: ContentDownloader; coordinator: SyncCoordinator };
type ContentContext = Runtime & {
  revision: number;
  busy: boolean;
  errors: string[];
  prepare: () => Promise<void>;
  refresh: () => void;
  reportError: (message: string) => void;
  sync: () => void;
  syncBusy: boolean;
  syncError: string | null;
  syncStatus: Awaited<ReturnType<AccountRepository['status']>> | null;
  authenticate: (token: string) => Promise<void>;
};
const Context = createContext<ContentContext | null>(null);

export function ContentProvider({ children }: PropsWithChildren) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<Awaited<ReturnType<AccountRepository['status']>> | null>(null);
  const token = useRef(''); // Dev credential stays in memory, never SQLite/EXPO_PUBLIC.
  const wake = useRef<() => void>(() => {});
  const sync = useCallback(() => wake.current(), []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const reportError = useCallback((message: string) => setErrors((previous) => [...previous, message]), []);
  useEffect(() => {
    if (!__DEV__) return;
    let live = true;
    let finished = false;
    let keep = false;
    let close: (() => Promise<void>) | undefined;
    void (async () => {
      const connection = await openContentDatabase();
      close = connection.close;
      const identity = await openLocalDatabase('storylex-dev-context-v1.db');
      let userId: string | undefined;
      try {
        await identity.database.execAsync('CREATE TABLE IF NOT EXISTS dev_account (id INTEGER PRIMARY KEY CHECK(id = 1), user_id TEXT NOT NULL)');
        userId = (await identity.database.getFirstAsync<{ user_id: string }>('SELECT user_id FROM dev_account WHERE id = 1'))?.user_id;
      } finally { await identity.close(); }
      if (!userId) { if (live) setNeedsLogin(true); return; }
      if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('Некорректный контекст аккаунта.');
      const local = await openLocalDatabase(`storylex-account-${userId}-v1.db`);
      close = async () => { await local.close(); await connection.close(); };
      const db = connection.database;
      await migrate(db);
      const deviceId = await migrateAccount(local.database, userId, randomUUID());
      const repository = new ContentRepository(db);
      const learning = new AccountRepository(local.database, userId, deviceId, randomUUID, sync);
      const coordinator = new SyncCoordinator(learning, API_URL, () => token.current, refresh);
      const closeConnections = close;
      close = async () => { await coordinator.stop(); await closeConnections(); };
      try {
        await repository.activateReady();
      } catch {
        if (live) setErrors(['Не удалось применить обновление. Доступна сохранённая версия материалов.']);
      }
      const downloader = new ContentDownloader(repository, API_URL,
        (text) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text));
      // Warm content is read from SQLite; progress sync starts independently.
      if (await repository.catalog() === null) {
        const issues = await downloader.prepare();
        if (live) setErrors(issues);
      }
      if (live) { keep = true; setNeedsLogin(false); setRuntime({ repository, learning, downloader, coordinator }); }
    })().catch((error: unknown) => {
      if (live) setErrors([error instanceof Error ? error.message : 'Не удалось подготовить материалы.']);
    }).finally(() => {
      finished = true;
      if (!live || !keep) void close?.();
    });
    return () => { live = false; if (finished && keep) void close?.(); };
  }, [attempt]);

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let active = AppState.currentState === 'active';
    const run = async () => {
      if (!live || !active) return;
      clearTimeout(timer);
      setSyncBusy(true);
      let delay = 30000;
      try {
        await runtime.coordinator.sync();
        failures = 0;
        if (live) setSyncError(null);
      } catch (error) {
        failures++;
        delay = Math.min(300000, 1000 * 2 ** Math.min(failures - 1, 9)) * (0.5 + Math.random() * 0.5);
        if (error instanceof SyncHttpError && error.retryAfter !== null) delay = Math.max(delay, error.retryAfter);
        if (live) setSyncError(error instanceof Error ? error.message : 'Сеть недоступна. Очередь сохранена.');
      } finally {
        if (live) {
          try { setSyncStatus(await runtime.learning.status()); } catch { setSyncError('Не удалось прочитать состояние sync.'); }
          setSyncBusy(false); refresh();
          clearTimeout(timer);
          timer = setTimeout(() => { void run(); }, delay);
        }
      }
    };
    wake.current = () => { void run(); };
    const subscription = AppState.addEventListener('change', (state) => {
      active = state === 'active';
      if (active) void run(); else clearTimeout(timer);
    });
    void run();
    return () => { live = false; wake.current = () => {}; clearTimeout(timer); subscription.remove(); };
  }, [runtime, refresh]);

  async function authenticate(value: string): Promise<void> {
    const userId = await devSession(API_URL, value.trim());
    if (runtime && runtime.learning.userId !== userId) throw new Error('Токен другого аккаунта. Смена аккаунтов появится с OAuth.');
    const identity = await openLocalDatabase('storylex-dev-context-v1.db');
    try {
      await identity.database.execAsync('CREATE TABLE IF NOT EXISTS dev_account (id INTEGER PRIMARY KEY CHECK(id = 1), user_id TEXT NOT NULL)');
      const existing = await identity.database.getFirstAsync<{ user_id: string }>('SELECT user_id FROM dev_account WHERE id = 1');
      if (existing && existing.user_id !== userId) throw new Error('Сохранён другой dev-аккаунт. Его прогресс не изменён.');
      await identity.database.runAsync('INSERT INTO dev_account (id, user_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING', userId);
    } finally { await identity.close(); }
    token.current = value.trim();
    if (runtime) sync(); else { setNeedsLogin(false); setErrors([]); setAttempt((value) => value + 1); }
  }

  // There is no public login bypass. Stage 1.3 exposes only a development shell.
  if (!__DEV__) return <Page><Heading>Storylex</Heading><Copy>Эта сборка ещё не готова к использованию. Вход появится в следующем этапе.</Copy></Page>;
  if (needsLogin && !runtime) return <Page><Heading>Dev-вход для этапа 1.5</Heading>
    <Copy>Войдите тестовым токеном локального сервера. Предыдущие результаты 1.4 сохранены отдельно. После первого входа уроки доступны без сети.</Copy>
    <DevLogin authenticate={authenticate} />
  </Page>;
  if (!runtime) return <Page><Heading>Подготовка материалов</Heading>{errors.length === 0 ? <ActivityIndicator /> : <>
    <Copy>{errors.join('\n')}</Copy><Action label="Повторить" onPress={() => { setErrors([]); setAttempt((value) => value + 1); }} />
  </>}</Page>;

  async function prepare() {
    if (!runtime || busy) return;
    setBusy(true);
    setErrors([]);
    try {
      setErrors(await runtime.downloader.prepare());
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Не удалось обновить материалы.']);
    } finally {
      setRevision((value) => value + 1);
      setBusy(false);
    }
  }
  return <Context.Provider value={{ ...runtime, revision, busy, errors, prepare, refresh, reportError,
    sync, syncBusy, syncError, syncStatus, authenticate }}>{children}</Context.Provider>;
}

export function DevLogin({ authenticate }: { authenticate: (token: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return <><TextInput accessibilityLabel="Dev-токен" placeholder="Dev-токен" secureTextEntry autoCapitalize="none" autoCorrect={false}
    value={value} onChangeText={setValue} style={{ padding: 12, backgroundColor: '#eee', color: '#111' }} />
    <Action label={busy ? 'Проверка…' : 'Подключить dev-sync'} disabled={busy || !value.trim()} onPress={() => {
      setBusy(true); setError(null);
      void authenticate(value).then(() => setValue('')).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Ошибка dev-входа.')).finally(() => setBusy(false));
    }} />{error && <Copy>{error}</Copy>}</>;
}

export function useContent(): ContentContext {
  const context = useContext(Context);
  if (!context) throw new Error('Локальное хранилище ещё не открыто.');
  return context;
}

export function useLocalQuery<T>(query: (repository: ContentRepository) => Promise<T>, initial: T): { value: T; error: string | null } {
  const { repository, revision } = useContent();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void query(repository).then((result) => {
      if (live) { setValue(result); setError(null); }
    }).catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : 'Ошибка локальных данных.'); });
    return () => { live = false; };
  }, [query, repository, revision]);
  return { value, error };
}
