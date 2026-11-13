import { ActivityIndicator, Text, View, type LayoutChangeEvent } from 'react-native';
import { currentTask, type Session } from '../domain/lesson.ts';
import type { SaveState } from '../domain/lesson-run.ts';
import { ChoiceExercise, PairsExercise } from './lesson.tsx';
import { LessonFooter, LessonFrame } from './lesson-frame.tsx';
import { exercisePlacement, type LessonLayout } from './lesson-layout.ts';
import { useLessonTypography } from './lesson-typography.tsx';
import { useColors } from './common.tsx';

export function LessonExercise({ session, saveState, value, layout, onLayout, onClose, onAnswer, onPair, onContinue, onRetry }: {
  session: Session; saveState: SaveState; value: number; layout: LessonLayout; onLayout: (event: LayoutChangeEvent) => void;
  onClose: () => void; onAnswer: (id: string) => void; onPair: (side: 'left' | 'right', id: string) => void; onContinue: () => void; onRetry: () => void;
}) {
  const colors = useColors();
  const task = currentTask(session);
  const typography = useLessonTypography(session.lesson, task, layout);
  const { composition } = typography;
  const placement = exercisePlacement(layout, composition, typography.promptTextHeight, task.kind === 'pairs', task.kind === 'choice' && task.type === 'word_to_translation');
  const selected = session.feedback && task.kind === 'choice' ? session.answers.at(-1)?.optionId ?? null : null;
  const waitingForSave = session.finished && session.mode === 'lesson' && saveState !== 'saved';
  return <LessonFrame layout={layout} value={value} onLayout={onLayout} onClose={onClose} contentKey={session.index}
    contentHeight={placement.canvasHeight} scroll={placement.scroll || saveState === 'error'} measurements={typography.probes}
    footer={<LessonFooter layout={layout} feedback={session.feedback} pairs={task.kind === 'pairs'} waitingForSave={waitingForSave}
      saveError={saveState === 'error'} onContinue={onContinue} onRetry={onRetry} />}>
    {typography.ready ? <View testID="exercise-canvas" style={{ height: placement.canvasHeight, paddingHorizontal: layout.horizontal, paddingVertical: placement.outerPadding, gap: 6 }}>
      <Text textBreakStrategy="highQuality" style={{ includeFontPadding: false, height: composition.metadataHeight, color: colors.muted, fontSize: 13, lineHeight: 18 }}>
        {session.mode === 'repeat' ? 'Короткое повторение' : `Урок ${session.lesson.position}`} · 5 слов
      </Text>
      {task.kind === 'choice'
        ? <ChoiceExercise task={task} selected={selected} layout={layout} composition={composition} placement={placement} typography={typography} onAnswer={onAnswer} />
        : <PairsExercise task={task} state={session.pairs} layout={layout} composition={composition} placement={placement} typography={typography} onSelect={onPair} />}
    </View> : <View style={{ height: placement.canvasHeight, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={colors.accent} accessibilityLabel="Открываем задание" />
    </View>}
    {saveState === 'error' && <Text accessibilityLiveRegion="polite" style={{ includeFontPadding: false, padding: layout.horizontal, color: colors.bad, fontSize: 16, lineHeight: 23 }}>
      Результат пока не сохранён. Повторите запись. Если ошибка остаётся, проверьте свободное место на устройстве.
    </Text>}
  </LessonFrame>;
}
