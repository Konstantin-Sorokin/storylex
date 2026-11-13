import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { PrimaryAction, Progress } from './lesson.tsx';
import { useColors } from './common.tsx';
import type { LessonLayout } from './lesson-layout.ts';

// Safe area is already applied by app/_layout. All three regions are normal flex
// siblings: the middle viewport always excludes the header AND the footer.
export function LessonFrame({ layout, value, onClose, onLayout, contentKey, footer, children, contentHeight, scroll = false, measurements }: {
  layout: LessonLayout; value: number; onClose: () => void;
  onLayout?: (event: LayoutChangeEvent) => void; contentKey: number; footer: ReactNode; children: ReactNode;
  contentHeight?: number; scroll?: boolean; measurements?: ReactNode;
}) {
  const colors = useColors();
  return <View testID="lesson-frame" onLayout={onLayout} style={{ flex: 1, minHeight: 0, backgroundColor: colors.background }}>
    <View testID="lesson-header" style={{ height: layout.headerHeight, paddingHorizontal: layout.horizontal, paddingVertical: 2, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Закрыть занятие" onPress={onClose}
        style={{ minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' }}>
        <Text allowFontScaling={false} style={{ color: colors.muted, fontSize: 28 }}>×</Text>
      </Pressable><Progress value={value} />
    </View>
    <ScrollView key={contentKey} testID="lesson-content" style={{ flex: 1, minHeight: 0 }} scrollEnabled={scroll} showsVerticalScrollIndicator={scroll}
      contentContainerStyle={{ minHeight: contentHeight ?? layout.centerHeight }}>
      {children}
    </ScrollView>
    <View testID="lesson-footer" style={{ height: layout.footerHeight, flexShrink: 0, borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.card,
      paddingHorizontal: layout.horizontal, paddingTop: 6, paddingBottom: 10, gap: 6, justifyContent: 'space-between' }}>
      {footer}
    </View>
    {measurements}
  </View>;
}

export function LessonFooter({ layout, feedback, pairs, waitingForSave, saveError, onContinue, onRetry }: {
  layout: LessonLayout; feedback: { correct: boolean } | null; pairs: boolean; waitingForSave: boolean; saveError: boolean;
  onContinue: () => void; onRetry: () => void;
}) {
  const colors = useColors();
  const status = saveError ? '× Не сохранено' : waitingForSave ? 'Сохраняем…'
    : feedback ? feedback.correct ? pairs ? '✓ Пары найдены' : '✓ Верно!' : '× Неверно'
      : pairs ? 'Найдите 5 пар' : 'Выберите ответ';
  const color = saveError || feedback?.correct === false ? colors.bad : feedback ? colors.good : colors.muted;
  return <>
    <View style={{ height: layout.footerStatusHeight, justifyContent: 'center' }}>
      <Text accessibilityLiveRegion="polite" style={{ color, fontSize: 18, lineHeight: 24, fontWeight: '600' }}>{status}</Text>
    </View>
    <PrimaryAction compact minHeight={layout.actionHeight} label={saveError ? 'Повторить' : 'Продолжить'}
      onPress={saveError ? onRetry : onContinue} disabled={!feedback || (waitingForSave && !saveError)} />
  </>;
}
