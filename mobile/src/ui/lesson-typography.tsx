import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { Lesson } from '../domain/content.ts';
import type { Task } from '../domain/lesson.ts';
import { fittedFont, fontCandidates, lessonComposition, emptyMinimumSizes, type LessonLayout, type TextBox } from './lesson-layout.ts';
import { minimumSamples, minimumSizes, sampleKey, sampleLineHeight, type TextSample } from './lesson-measurements.ts';

export function TextProbes({ samples, scale, onMeasure }: { samples: readonly TextSample[]; scale: number; onMeasure: (key: string, box: TextBox) => void }) {
  return <View testID="text-probes" pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ position: 'absolute', top: 0, left: 0, opacity: 0 }}>
    {samples.map((sample) => <Text key={sampleKey(sample, scale)} allowFontScaling textBreakStrategy="highQuality"
      style={{ includeFontPadding: false, width: sample.width, fontSize: sample.font, lineHeight: sampleLineHeight(sample) }}
      onTextLayout={({ nativeEvent }) => {
        if (!nativeEvent.lines.length) return;
        onMeasure(sampleKey(sample, scale), { height: Math.ceil(Math.max(...nativeEvent.lines.map((line) => line.y + line.height))),
          width: Math.max(...nativeEvent.lines.map((line) => line.width)), lines: nativeEvent.lines.length });
      }}>
      {sample.parts ? sample.parts.map((part, index) => <Text key={index} style={part.target ? { fontWeight: '700' } : undefined}>{part.text}</Text>) : sample.text}
    </Text>)}
  </View>;
}

export function useLessonTypography(lesson: Lesson, task: Task, layout: LessonLayout) {
  const [boxes, setBoxes] = useState<ReadonlyMap<string, TextBox>>(new Map());
  const minimum = useMemo(() => minimumSamples(lesson, layout), [lesson, layout.cardWidth, layout.optionTextWidth, layout.pairTextWidth]);
  const measured = minimumSizes(minimum, boxes, layout.fontScale);
  const composition = lessonComposition(layout, measured ?? emptyMinimumSizes());
  const prompt = task.kind === 'choice' ? task.question.prompt : 'Найди 5 пар';
  const answers = task.kind === 'choice' ? task.question.options.map((option) => option.text) : [...task.left, ...task.right].map((item, index) => index < 5 ? item.en : item.ru);
  // Measurements do not depend on option order. Corrections with reshuffled
  // options can reuse the same metrics without changing the displayed order.
  answers.sort();
  const promptCandidates = fontCandidates([prompt]);
  const answerCandidates = fontCandidates(answers, task.kind === 'pairs');
  const promptSamples: TextSample[] = promptCandidates.map((font) => ({ id: 'fit-prompt', text: prompt, font, width: layout.cardWidth }));
  const answerSamples: TextSample[] = answerCandidates.flatMap((font) => answers.map((text, index) => ({ id: `fit-answer:${index}`, text, font,
    width: task.kind === 'pairs' ? layout.pairTextWidth : layout.optionTextWidth })));
  const all = [...minimum, ...promptSamples, ...answerSamples];
  const pending = all.filter((sample) => !boxes.has(sampleKey(sample, layout.fontScale)));
  const promptBoxes = new Map<number, TextBox[]>();
  const answerBoxes = new Map<number, TextBox[]>();
  for (const sample of promptSamples) {
    const box = boxes.get(sampleKey(sample, layout.fontScale));
    if (box) promptBoxes.set(sample.font, [box]);
  }
  for (const font of answerCandidates) {
    const rows = answerSamples.filter((sample) => sample.font === font).map((sample) => boxes.get(sampleKey(sample, layout.fontScale)));
    if (rows.every((row): row is TextBox => row !== undefined)) answerBoxes.set(font, rows);
  }
  const promptHeight = composition.questionBodyHeight - (task.kind === 'choice' && task.type === 'word_to_translation' ? composition.exampleHeight + 6 : 0);
  const promptFont = fittedFont(promptCandidates, promptBoxes, layout.cardWidth, promptHeight);
  return {
    composition, ready: measured !== null && pending.length === 0,
    promptFont,
    promptTextHeight: promptBoxes.get(promptFont)?.[0]?.height ?? promptHeight,
    answerFont: fittedFont(answerCandidates, answerBoxes, task.kind === 'pairs' ? layout.pairTextWidth : layout.optionTextWidth,
      (task.kind === 'pairs' ? composition.pairHeight : composition.cardHeight) - 15),
    probes: <TextProbes samples={pending} scale={layout.fontScale} onMeasure={(key, box) => setBoxes((previous) => {
      const old = previous.get(key);
      if (old?.height === box.height && old.width === box.width && old.lines === box.lines) return previous;
      return new Map(previous).set(key, box);
    })} />,
  };
}
