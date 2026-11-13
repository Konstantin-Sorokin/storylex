import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChoiceTask, PairState, PairsTask } from '../domain/lesson.ts';
import type { LearningItem, Segment } from '../domain/content.ts';
import { useColors } from './common.tsx';
import { lineHeight, type LessonLayout, type LessonComposition, type ExercisePlacement } from './lesson-layout.ts';
import { exerciseLabels } from './lesson-measurements.ts';

export function PrimaryAction({ label, onPress, disabled = false, compact = false, minHeight }: {
  label: string; onPress: () => void; disabled?: boolean; compact?: boolean; minHeight?: number;
}) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.primary, compact && styles.compactPrimary, minHeight !== undefined && { minHeight },
      { backgroundColor: colors.accent, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }]}>
    <Text style={{ includeFontPadding: false, color: colors.onAccent, fontSize: compact ? 17 : 18, lineHeight: 22, fontWeight: '700', textAlign: 'center' }}>{label}</Text>
  </Pressable>;
}

export function Progress({ value }: { value: number }) {
  const colors = useColors();
  const percent = value === 1 ? 100 : Math.min(99, Math.round(value * 100));
  return <View accessibilityRole="progressbar" accessibilityLabel="Прогресс занятия" accessibilityValue={{ min: 0, max: 100, now: percent }} style={{ flex: 1, gap: 6 }}>
    <View style={{ height: 8, borderRadius: 8, backgroundColor: colors.line, overflow: 'hidden' }}>
      <View style={{ width: `${value * 100}%`, height: '100%', borderRadius: 8, backgroundColor: colors.accent }} />
    </View>
    <Text style={{ includeFontPadding: false, color: colors.muted, fontSize: 12, textAlign: 'right' }}>{percent}%</Text>
  </View>;
}

export type ExerciseTypography = { promptFont: number; answerFont: number };
export function ChoiceExercise({ task, selected, onAnswer, layout, composition, placement, typography }: {
  task: ChoiceTask; selected: string | null; onAnswer: (id: string) => void; layout: LessonLayout;
  composition: LessonComposition; placement: ExercisePlacement; typography: ExerciseTypography;
}) {
  const colors = useColors();
  const word = task.type === 'word_to_translation';
  return <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
    <View style={{ flex: 1, minHeight: 0, gap: layout.questionGap }}>
    <View testID="question-region" style={{ height: placement.questionHeight, flexShrink: 0, gap: 8 }}>
      <Text textBreakStrategy="highQuality" style={{ includeFontPadding: false, height: composition.headingHeight, color: colors.muted, fontSize: 12, lineHeight: 18 }}>{exerciseLabels[task.type]}</Text>
      <View style={{ height: placement.promptTextHeight, justifyContent: 'center' }}>
        <Text textBreakStrategy="highQuality" accessibilityRole="header"
          style={{ includeFontPadding: false, color: colors.text, fontSize: typography.promptFont, lineHeight: lineHeight(typography.promptFont), textAlign: typography.promptFont >= 21 ? 'center' : 'left' }}>{task.question.prompt}</Text>
      </View>
    </View>
    <View testID="answer-region" style={{ flex: 1, minHeight: placement.gridHeight, justifyContent: 'center', gap: placement.optionGap }}>
      {task.question.options.map((option) => {
        const correct = selected !== null && option.id === task.question.correct_option_id;
        const wrong = selected === option.id && !correct;
        const color = correct ? colors.good : wrong ? colors.bad : colors.text;
        const status = correct ? 'Верный ответ' : wrong ? 'Ваш ответ, неверно' : '';
        return <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={`${option.text}${status ? '. ' + status : ''}`}
          accessibilityState={{ disabled: selected !== null, selected: selected === option.id }} disabled={selected !== null} onPress={() => onAnswer(option.id)}
          style={({ pressed }) => [styles.option, { height: placement.cardHeight, flexShrink: 0, borderColor: correct ? colors.good : wrong ? colors.bad : colors.line,
            backgroundColor: correct ? colors.goodSurface : wrong ? colors.badSurface : colors.card, opacity: pressed ? 0.75 : 1 }]}>
          <Text textBreakStrategy="highQuality" style={{ includeFontPadding: false, color, fontSize: typography.answerFont, lineHeight: lineHeight(typography.answerFont), flex: 1,
            textAlign: typography.answerFont >= 21 ? 'center' : 'left' }}>{option.text}</Text>
          <View accessible={false} importantForAccessibility="no-hide-descendants" style={styles.answerMark}>
            <Text allowFontScaling={false} style={{ includeFontPadding: false, color, fontSize: 20 }}>{correct ? '✓' : wrong ? '×' : ' '}</Text>
          </View>
        </Pressable>;
      })}
    </View>
    </View>
    {word && <View testID="word-example" accessibilityElementsHidden={selected === null} importantForAccessibility={selected === null ? 'no-hide-descendants' : 'auto'}
      style={{ height: composition.exampleHeight, flexShrink: 0, opacity: selected === null ? 0 : 1, justifyContent: 'center' }}>
      <WordExample item={task.item} />
    </View>}
  </View>;
}

export function PairsExercise({ task, state, onSelect, layout, composition, placement, typography }: {
  task: PairsTask; state: PairState; onSelect: (side: 'left' | 'right', id: string) => void;
  layout: LessonLayout; composition: LessonComposition; placement: ExercisePlacement; typography: ExerciseTypography;
}) {
  const colors = useColors();
  const gridHeight = placement.gridHeight;
  return <View style={{ flex: 1, minHeight: 0, gap: layout.questionGap }}>
    <View testID="question-region" style={{ height: placement.questionHeight, flexShrink: 0, gap: 8 }}>
      <Text style={{ includeFontPadding: false, height: composition.headingHeight, color: colors.muted, fontSize: 12, lineHeight: 18 }}>СОБЕРИТЕ СООТВЕТСТВИЯ · Выберите слово и перевод</Text>
      <View style={{ height: placement.promptTextHeight, justifyContent: 'center' }}>
        <Text textBreakStrategy="highQuality" accessibilityRole="header" style={{ includeFontPadding: false, color: colors.text, fontSize: typography.promptFont, lineHeight: lineHeight(typography.promptFont) }}>
          Найди 5 пар
        </Text>
      </View>
    </View>
    <View testID="answer-region" style={{ flex: 1, minHeight: placement.answerHeight }}>
      <View style={{ flex: 1, minHeight: gridHeight, flexDirection: 'row', gap: 10 }}>
        {(['left', 'right'] as const).map((side) => <View key={side} style={{ flex: 1, justifyContent: 'center', gap: placement.optionGap }}>
          {task[side].map((item) => {
            const matched = state.matched.includes(item.id);
            const selected = state[side] === item.id;
            const wrong = selected && state.wrong;
            const color = matched ? colors.good : wrong ? colors.bad : selected ? colors.accent : colors.text;
            return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item[side === 'left' ? 'en' : 'ru']}${matched ? ', пара найдена' : ''}`}
              accessibilityState={{ disabled: matched || state.wrong, selected }} disabled={matched || state.wrong}
              onPress={() => onSelect(side, item.id)} style={[styles.pair, { height: placement.cardHeight, flexShrink: 0, borderColor: matched || wrong || selected ? color : colors.line,
                backgroundColor: matched ? colors.goodSurface : wrong ? colors.badSurface : colors.card }]}>
              <Text textBreakStrategy="highQuality" style={{ includeFontPadding: false, color, fontSize: typography.answerFont, lineHeight: lineHeight(typography.answerFont), textAlign: 'center', flex: 1 }}>{item[side === 'left' ? 'en' : 'ru']}</Text>
              <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: 16, alignItems: 'center' }}>
                <Text allowFontScaling={false} style={{ includeFontPadding: false, color, fontSize: 16 }}>{matched ? '✓' : ' '}</Text>
              </View>
            </Pressable>;
          })}
        </View>)}
      </View>
      <View style={{ height: composition.pairStatusHeight, flexShrink: 0, marginTop: 6, justifyContent: 'center' }}>
        <Text accessibilityLiveRegion="polite" style={{ includeFontPadding: false, color: state.wrong ? colors.bad : colors.muted, fontSize: 15, lineHeight: lineHeight(15), textAlign: 'center' }}>
          {state.wrong ? 'Эти слова не составляют пару. Попробуйте ещё раз.' : `Найдено пар: ${state.matched.length} из 5`}
        </Text>
      </View>
    </View>
  </View>;
}

function RichExample({ parts }: { parts: Segment[] }) {
  const colors = useColors();
  return <Text textBreakStrategy="highQuality" style={{ includeFontPadding: false, color: colors.text, fontSize: 16, lineHeight: lineHeight(16) }}>{parts.map((part, index) =>
    <Text key={index} style={part.target ? { fontWeight: '700' } : undefined}>{part.text}</Text>)}</Text>;
}
export function WordExample({ item }: { item: LearningItem }) {
  return <View style={{ gap: 4 }}><RichExample parts={item.example.en} /><RichExample parts={item.example.ru} /></View>;
}
export function WordList({ items }: { items: LearningItem[] }) {
  const colors = useColors();
  return <View>{items.map((item, index) => <View key={item.id} style={{ paddingVertical: 16, gap: 5,
    borderBottomWidth: index === items.length - 1 ? 0 : StyleSheet.hairlineWidth, borderColor: colors.line }}>
    <Text style={{ includeFontPadding: false, color: colors.text, fontSize: 22, fontWeight: '600' }}>{item.en}</Text>
    <Text style={{ includeFontPadding: false, color: colors.muted, fontSize: 18, lineHeight: 26 }}>{item.ru}</Text>
  </View>)}</View>;
}
const styles = StyleSheet.create({
  primary: { minHeight: 56, paddingVertical: 16, paddingHorizontal: 20, borderRadius: 16, justifyContent: 'center' },
  compactPrimary: { minHeight: 48, paddingVertical: 10, borderRadius: 14 },
  option: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1.5, flexDirection: 'row', gap: 8, alignItems: 'center' },
  answerMark: { width: 22, alignItems: 'center', flexShrink: 0 },
  pair: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1.5, flexDirection: 'row', alignItems: 'center', gap: 4 },
});
