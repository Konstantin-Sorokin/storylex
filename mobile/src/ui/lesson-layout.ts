// All dimensions are React Native points INSIDE the root SafeAreaView.
export function lessonLayout(width: number, height: number, fontScale: number) {
  const horizontal = width >= 400 ? 20 : 16;
  const statusLines = Math.max(1, Math.ceil(16 * 18 * 0.7 * fontScale / Math.max(1, width - horizontal * 2)));
  const footerStatusHeight = 24 * fontScale * statusLines;
  const actionLines = Math.max(1, Math.ceil(11 * 17 * 0.7 * fontScale / Math.max(1, width - horizontal * 2 - 40)));
  const actionHeight = Math.max(48, 22 * fontScale * actionLines + 20);
  const headerHeight = Math.max(height * 0.10, 52, 14 + 16 * fontScale);
  const footerHeight = Math.max(height * 0.16, footerStatusHeight + actionHeight + 22);
  const centerHeight = Math.max(1, height - headerHeight - footerHeight);
  return {
    width, height, fontScale, horizontal, headerHeight, footerHeight, centerHeight,
    footerStatusHeight, actionHeight, vertical: 8, optionGap: 6, questionGap: 10,
    cardWidth: Math.max(1, width - 2 * horizontal),
    optionTextWidth: Math.max(1, width - 2 * horizontal - 24 - 3 - 22 - 8),
    pairTextWidth: Math.max(1, (width - 2 * horizontal - 10) / 2 - 20 - 3 - 16 - 4),
  };
}
export type LessonLayout = ReturnType<typeof lessonLayout>;
export type TextBox = { height: number; width: number; lines: number };
export const lineHeight = (font: number) => Math.ceil(font * 1.25);

// Word counts only choose a starting range. Native line measurements below
// choose the actual size, including wide glyphs, wrapping and system font scale.
export function fontCandidates(texts: readonly string[], pairs = false): number[] {
  const words = Math.max(...texts.map((text) => text.trim().split(/\s+/u).length));
  if (pairs) return [24, 22, 20, 18, 16];
  return words === 1 ? [30, 29, 28, 27, 26] : words <= 5 ? [24, 23, 22, 21] : [19, 18, 17, 16];
}

export function fittedFont(candidates: readonly number[], boxes: ReadonlyMap<number, readonly TextBox[]>, width: number, height: number): number {
  const minimum = candidates.at(-1) ?? 16;
  return candidates.find((font) => {
    const rows = boxes.get(font);
    return rows && rows.every((row) => row.width <= width + 0.5 && row.height <= height + 0.5 && row.lines <= 3);
  }) ?? minimum;
}

export type MinimumSizes = { metadata: number; heading: number; prompt: number; wordPrompt: number; example: number; answer: number; pair: number; pairStatus: number };
export const emptyMinimumSizes = (): MinimumSizes => ({ metadata: 0, heading: 0, prompt: 0, wordPrompt: 0, example: 0, answer: 0, pair: 0, pairStatus: 0 });

// Minimum measurements come from the entire pinned lesson, not the current task.
// Thus ordinary questions, corrections and repeat never reflow the grid on Next.
export function lessonComposition(layout: LessonLayout, measured: MinimumSizes) {
  const metadataHeight = Math.max(18 * layout.fontScale, measured.metadata);
  const headingHeight = Math.max(18 * layout.fontScale, measured.heading);
  const exampleHeight = measured.example;
  const bodyMinimum = Math.max(measured.prompt, measured.wordPrompt + (exampleHeight ? exampleHeight + 6 : 0));
  const usable = layout.centerHeight - layout.vertical * 2 - metadataHeight - 6;
  const questionHeight = Math.max(128, usable * 0.30, headingHeight + 8 + bodyMinimum);
  const remaining = usable - questionHeight - layout.questionGap;
  // 15 points = two 6-point vertical paddings + two 1.5-point borders.
  const cardHeight = Math.max(64, Math.min(92, (remaining - layout.optionGap * 3) / 4), measured.answer + 15);
  const pairStatusHeight = Math.max(42 * layout.fontScale, measured.pairStatus);
  const pairHeight = Math.max(48, Math.min(68, (remaining - pairStatusHeight - 6 - layout.optionGap * 4) / 5), measured.pair + 15);
  const answerHeight = Math.max(remaining, cardHeight * 4 + layout.optionGap * 3, pairHeight * 5 + layout.optionGap * 4 + pairStatusHeight + 6);
  const canvasHeight = layout.vertical * 2 + metadataHeight + 6 + questionHeight + layout.questionGap + answerHeight;
  return { metadataHeight, headingHeight, exampleHeight, questionHeight, cardHeight, pairHeight, pairStatusHeight, answerHeight, canvasHeight,
    questionBodyHeight: questionHeight - headingHeight - 8,
    scroll: canvasHeight > layout.centerHeight + 0.5 };
}
export type LessonComposition = ReturnType<typeof lessonComposition>;

// Keep the typography budget above intact. Anchor the measured question at the
// top; give the remaining height to equally sized answers and uniform gaps.
export function exercisePlacement(layout: LessonLayout, sizes: LessonComposition, promptTextHeight: number, pairs: boolean, word: boolean) {
  const questionHeight = sizes.headingHeight + 8 + promptTextHeight;
  const rows = pairs ? 5 : 4;
  const minimumCardHeight = pairs ? sizes.pairHeight : sizes.cardHeight;
  const minimumGridHeight = minimumCardHeight * rows + layout.optionGap * (rows - 1);
  const statusHeight = pairs ? sizes.pairStatusHeight + 6 : 0;
  // The example slot exists before selection too, so feedback never moves cards.
  const exampleHeight = word ? sizes.exampleHeight + 6 : 0;
  const fixedHeight = layout.vertical * 2 + sizes.metadataHeight + 6 + questionHeight + layout.questionGap + statusHeight + exampleHeight;
  const canvasHeight = Math.max(layout.centerHeight, fixedHeight + minimumGridHeight);
  const availableGridHeight = canvasHeight - fixedHeight;
  const surplus = Math.max(0, availableGridHeight - minimumGridHeight);
  // Roughly a third of the surplus opens up the gaps; the rest grows the cards.
  // Once the comfortable caps are reached, only the answer container has insets.
  const optionGap = Math.min(24, layout.optionGap + surplus / (3 * (rows - 1)));
  const cardHeight = Math.min(Math.max(minimumCardHeight, pairs ? 78 : 104), (availableGridHeight - optionGap * (rows - 1)) / rows);
  const gridHeight = cardHeight * rows + optionGap * (rows - 1);
  const answerHeight = availableGridHeight + statusHeight;
  const contentHeight = canvasHeight - layout.vertical * 2;
  return { promptTextHeight, questionHeight, gridHeight, answerHeight, contentHeight, canvasHeight,
    cardHeight, optionGap, outerPadding: layout.vertical, scroll: canvasHeight > layout.centerHeight + 0.5 };
}
export type ExercisePlacement = ReturnType<typeof exercisePlacement>;
