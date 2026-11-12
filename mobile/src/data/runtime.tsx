import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator } from 'react-native';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { ContentRepository } from './content-repository.ts';
import { migrate } from './database.ts';
import { openContentDatabase } from './expo-database.ts';
import { ContentDownloader } from '../infrastructure/downloader.ts';
import { Action, Copy, Heading, Page } from '../ui/common.tsx';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8000/api/v1/';
type Runtime = { repository: ContentRepository; downloader: ContentDownloader };
type ContentContext = Runtime & {
  revision: number;
  busy: boolean;
  errors: string[];
  prepare: () => Promise<void>;
};
const Context = createContext<ContentContext | null>(null);

export function ContentProvider({ children }: PropsWithChildren) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!__DEV__) return;
    let live = true;
    let finished = false;
    let keep = false;
    let close: (() => Promise<void>) | undefined;
    void (async () => {
      const connection = await openContentDatabase();
      const db = connection.database;
      close = connection.close;
      await migrate(db);
      const repository = new ContentRepository(db);
      const downloader = new ContentDownloader(repository, API_URL,
        (text) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text));
      // A warm launch reads SQLite only. Navigation never starts a download.
      if (await repository.catalog() === null) {
        const issues = await downloader.prepare();
        if (live) setErrors(issues);
      }
      if (live) { keep = true; setRuntime({ repository, downloader }); }
    })().catch((error: unknown) => {
      if (live) setErrors([error instanceof Error ? error.message : 'Не удалось подготовить материалы.']);
    }).finally(() => {
      finished = true;
      if (!live || !keep) void close?.();
    });
    return () => { live = false; if (finished && keep) void close?.(); };
  }, [attempt]);

  // There is no public login bypass. Stage 1.3 exposes only a development shell.
  if (!__DEV__) return <Page><Heading>Storylex</Heading><Copy>Эта сборка ещё не готова к использованию. Вход появится в следующем этапе.</Copy></Page>;
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
  return <Context.Provider value={{ ...runtime, revision, busy, errors, prepare }}>{children}</Context.Provider>;
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
