import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useContent } from '../../../src/data/runtime.tsx';
import { lessonEntry, LessonRun } from '../../../src/domain/lesson-run.ts';
import { progress } from '../../../src/domain/lesson.ts';
import { Action, Copy, Heading, Page, useColors } from '../../../src/ui/common.tsx';
import { PrimaryAction, WordList } from '../../../src/ui/lesson.tsx';
import { LessonExercise } from '../../../src/ui/lesson-exercise.tsx';
import { lessonLayout } from '../../../src/ui/lesson-layout.ts';
import { confirmLessonExit, shouldConfirmLessonExit } from '../../../src/ui/lesson-exit.ts';

export default function LessonScreen() {
  const { productId, lessonId, mode } = useLocalSearchParams<{ productId: string; lessonId: string; mode?: string }>();
  const { repository, learning, refresh, reportError } = useContent();
  const colors = useColors();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // The measured frame is already inside the root SafeAreaView. Insets are only
  // used for the first-render fallback, never added to the footer a second time.
  const layout = lessonLayout(size?.width ?? window.width,
    size?.height ?? Math.max(1, window.height - insets.top - insets.bottom), window.fontScale);
  const [run, setRun] = useState<LessonRun | null>(null);
  const [, redraw] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [summary, setSummary] = useState(false);
  const [allowLeave, setAllowLeave] = useState(false);
  const [nextId, setNextId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let release: (() => Promise<void>) | undefined;
    setRun(null); setError(null); setSummary(false); setAllowLeave(false);
    void (async () => {
      const pinned = await repository.pinLesson(productId, lessonId);
      release = pinned.release;
      if (!live) { await release(); return; }
      const completed = await learning.completed(productId);
      if (!live) return;
      const { source } = pinned.context;
      const entry = lessonEntry(pinned.context, completed, mode);
      if (entry.alreadyCompleted) {
        router.replace({ pathname: '/chapters/[productId]/[sectionId]', params: { productId, sectionId: source.section_id ?? 'movie' } });
        return;
      }
      if (!live) return;
      setNextId(entry.nextId);
      setRun(new LessonRun(pinned.context, entry.mode, async (result) => {
        await learning.save(result);
        // Completion is durable already. A failed content update must not turn
        // it into a failed result or prevent leaving the lesson.
        try {
          await pinned.release();
          const latest = await repository.document(productId, source.section_id);
          const done = await learning.completed(productId);
          if (live) setNextId(latest?.lessons.find((lesson) => !done.has(lesson.id))?.id ?? null);
        } catch {
          reportError('Не удалось применить обновление после урока. Доступна сохранённая версия материалов.');
        }
        refresh();
      },
        () => { if (live) redraw((value) => value + 1); }));
    })().catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : 'Не удалось открыть урок.');
    });
    return () => {
      live = false;
      if (release) void release().then(refresh).catch(() => reportError('Не удалось активировать обновлённый пакет. Перезапустите приложение.'));
    };
  }, [productId, lessonId, mode, repository, learning, refresh, reportError, attempt]);

  const pairWrong = run?.session.pairs.wrong ?? false;
  useEffect(() => {
    if (!pairWrong || !run) return;
    const timer = setTimeout(() => run.clearPairError(), 650);
    return () => clearTimeout(timer);
  }, [pairWrong, run]);

  const unsafe = shouldConfirmLessonExit(run, summary);
  usePreventRemove(unsafe && !allowLeave, ({ repeat }) => {
    if (run) confirmLessonExit(run, () => { setAllowLeave(true); repeat(); });
  });

  function goBack() {
    if (router.canGoBack()) router.back();
    else if (run) router.replace({ pathname: '/chapters/[productId]/[sectionId]', params: { productId, sectionId: run.context.source.section_id ?? 'movie' } });
    else router.replace('/catalog');
  }

  if (!run) return <Page><Heading>Урок</Heading>{error ? <><Copy>{error}</Copy>
    <Action label="Повторить открытие" onPress={() => setAttempt((value) => value + 1)} /><Action label="Назад" onPress={goBack} />
  </> : <ActivityIndicator color={colors.accent} accessibilityLabel="Открываем скачанный урок" />}</Page>;

  if (summary) return <Page>
    <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '700', letterSpacing: 1.5 }}>ШАГ ВПЕРЁД</Text>
    <Heading>Урок завершён</Heading><Copy>Пять слов, которые теперь вам знакомы.</Copy>
    <WordList items={run.context.lesson.items} />
    <Text style={{ color: colors.muted, fontSize: 15 }}>Результат сохранён на устройстве.</Text>
    {nextId ? <PrimaryAction label="Следующий урок" onPress={() => router.replace({ pathname: '/lessons/[productId]/[lessonId]', params: { productId, lessonId: nextId } })} />
      : <><Copy>Вы прошли все уроки пробной части.</Copy><PrimaryAction label="Завершить пробную часть" onPress={goBack} /></>}
    {nextId && <Action label="Вернуться к главе" onPress={goBack} />}
  </Page>;

  const session = run.session;
  const saved = run.saveState === 'saved';
  const waitingForSave = session.finished && session.mode === 'lesson' && !saved;
  const displayedProgress = waitingForSave ? Math.min(0.99, progress(session)) : progress(session);
  function next() {
    if (session.finished) {
      if (session.mode === 'repeat') goBack();
      else if (saved) setSummary(true);
    } else run?.next();
  }
  return <LessonExercise session={session} saveState={run.saveState} layout={layout} value={displayedProgress} onClose={goBack}
    onLayout={({ nativeEvent }) => {
      const { width, height } = nativeEvent.layout;
      if (width <= 0 || height <= 0) return;
      setSize((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
    }}
    onAnswer={(id) => { void run.answer(id); }} onPair={(side, id) => run.pair(side, id)} onContinue={next} onRetry={() => { void run.persist(); }} />;
}
