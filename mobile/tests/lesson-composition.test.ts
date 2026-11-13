import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyMinimumSizes, exercisePlacement, fittedFont, fontCandidates, lessonComposition, lessonLayout, type TextBox } from '../src/ui/lesson-layout.ts';
import { minimumSamples, minimumSizes, sampleKey } from '../src/ui/lesson-measurements.ts';
import { fixture } from './fixtures.ts';

const standardMetrics = { metadata: 18, heading: 18, prompt: 60, wordPrompt: 33, example: 84, answer: 60, pair: 20, pairStatus: 38 };
const box = (width: number, height: number, lines: number): TextBox => ({ width, height, lines });

test('standard and tall usable Android containers keep 10/74/16 zones; compact/accessibility floors are independent of the task', () => {
  for (const [width, height] of [[360, 700], [393, 740], [412, 880]]) {
    const layout = lessonLayout(width!, height!, 1);
    assert.ok(Math.abs(layout.headerHeight / height! - 0.10) < 1e-8);
    assert.ok(Math.abs(layout.centerHeight / height! - 0.74) < 1e-8);
    assert.ok(Math.abs(layout.footerHeight / height! - 0.16) < 1e-8);
    const canvas = lessonComposition(layout, standardMetrics);
    assert.equal(canvas.scroll, false);
    assert.ok(canvas.cardHeight >= 75 && canvas.cardHeight <= 92);
    assert.ok(canvas.pairHeight >= 48);
    assert.ok(Math.abs(canvas.canvasHeight - layout.centerHeight) < 1e-8);
  }
  const compact = lessonLayout(320, 480, 1);
  const large = lessonLayout(360, 680, 2);
  assert.ok(compact.headerHeight >= 52 && compact.footerHeight >= 94);
  assert.ok(large.actionHeight >= 64);
  assert.ok(large.footerHeight > 680 * 0.16);
});

test('native line widths/heights choose the common answer font, not character count or independent per-option scaling', () => {
  assert.deepEqual(fontCandidates(['hole', 'путь', 'лес', 'дом']), [30, 29, 28, 27, 26]);
  assert.deepEqual(fontCandidates(['carry out', 'put away']), [24, 23, 22, 21]);
  const sentences = [
    'She decided to carry out the plan before the meeting began.',
    'Они решили выполнить этот план до начала следующей рабочей встречи.',
    'We will carry out every necessary check before opening the door.',
    'Она решила выполнить поручение после обеда и вернуться домой вовремя.',
  ];
  assert.deepEqual(fontCandidates(sentences), [19, 18, 17, 16]);
  const measured = new Map<number, TextBox[]>([
    [19, [box(260, 48, 2), box(270, 72, 3), box(260, 48, 2), box(260, 48, 2)]],
    [18, [box(250, 46, 2), box(270, 69, 3), box(250, 46, 2), box(250, 46, 2)]],
    [17, [box(245, 44, 2), box(268, 66, 3), box(245, 44, 2), box(245, 44, 2)]],
    [16, [box(240, 40, 2), box(260, 60, 3), box(240, 40, 2), box(240, 40, 2)]],
  ]);
  assert.equal(fittedFont(fontCandidates(sentences), measured, 280, 61), 16);
  assert.equal(fittedFont(fontCandidates(sentences), measured, 280, 80), 19);
  // The shortest string can be the widest (e.g. WWW vs iiiii); actual native
  // widths, not string length, determine whether a candidate fits.
  const words = new Map<number, TextBox[]>([
    [30, [box(285, 38, 1), box(80, 38, 1)]], [29, [box(282, 37, 1), box(78, 37, 1)]],
    [28, [box(275, 35, 1), box(76, 35, 1)]],
  ]);
  assert.equal(fittedFont(fontCandidates(['WWW', 'iiiiii']), words, 280, 45), 28);
});

test('minimum font is never reduced past its readable floor; longer text expands a shared scrollable canvas', () => {
  const layout = lessonLayout(320, 480, 2);
  const measured = { ...standardMetrics, prompt: 180, wordPrompt: 100, example: 180, answer: 160, pair: 100, metadata: 40, heading: 50, pairStatus: 80 };
  const composition = lessonComposition(layout, measured);
  assert.equal(composition.scroll, true);
  assert.ok(composition.canvasHeight > layout.centerHeight);
  assert.ok(composition.cardHeight >= measured.answer + 15);
  assert.ok(composition.pairHeight >= measured.pair + 15);
  assert.ok(composition.questionBodyHeight >= measured.wordPrompt + measured.example + 6);
  assert.equal(fittedFont([19, 18, 17, 16], new Map([[16, [box(240, 160, 8)]]]), 240, 80), 16);
  // Readable font and full text take precedence over the editorial 3-line guide.
  assert.ok(composition.cardHeight - 15 >= 160);
});

test('preflight covers all pinned lesson questions, options, pairs and rich examples; old width/font-scale measurements are not reused', async () => {
  const f = await fixture(); const lesson = f.source.lessons[0]!;
  const layout = lessonLayout(393, 740, 1);
  const samples = minimumSamples(lesson, layout);
  assert.equal(samples.filter((sample) => sample.role === 'answer').length, 60);
  assert.equal(samples.filter((sample) => sample.role === 'prompt' || sample.role === 'wordPrompt').length, 16);
  assert.equal(samples.filter((sample) => sample.role === 'pair').length, 10);
  const measurements = new Map<string, TextBox>();
  assert.equal(minimumSizes(samples, measurements, 1), null);
  for (const sample of samples) measurements.set(sampleKey(sample, 1), box(100, 20, 1));
  const sizes = minimumSizes(samples, measurements, 1);
  assert.ok(sizes); assert.equal(sizes.example, 44);
  assert.equal(minimumSizes(samples, measurements, 2), null);
  assert.equal(minimumSizes(minimumSamples(lesson, lessonLayout(360, 740, 1)), measurements, 1), null);
  const before = JSON.stringify(lesson);
  const stable = lessonComposition(layout, sizes);
  for (const item of lesson.items) for (const question of Object.values(item.exercises)) {
    assert.ok(question.options.length === 4);
    assert.deepEqual(lessonComposition(layout, sizes), stable);
  }
  assert.equal(JSON.stringify(lesson), before);
  assert.ok(lessonComposition(layout, emptyMinimumSizes()).cardHeight >= 64);
});

test('short words, full sentences and pairs fill the centre with a top-anchored question and evenly spaced equal cards', () => {
  for (const [width, height] of [[360, 700], [393, 740], [412, 880]] as const) {
    const layout = lessonLayout(width, height, 1);
    const sizes = lessonComposition(layout, standardMetrics);
    for (const [promptHeight, pairs, word] of [[33, false, true], [72, false, false], [30, true, false]] as const) {
      const placed = exercisePlacement(layout, sizes, promptHeight, pairs, word);
      assert.equal(placed.scroll, false);
      assert.equal(placed.outerPadding, 8); // no surplus above the question
      assert.ok(placed.outerPadding + sizes.metadataHeight + 6 < layout.centerHeight * 0.1);
      assert.equal(placed.questionHeight, sizes.headingHeight + 8 + promptHeight);
      const rows = pairs ? 5 : 4;
      const gridViewport = placed.answerHeight - (pairs ? sizes.pairStatusHeight + 6 : 0);
      const inset = (gridViewport - placed.gridHeight) / 2;
      assert.ok(inset >= -1e-8 && inset <= 32, 'surplus stays within a modest answer inset');
      assert.ok(placed.gridHeight / gridViewport >= 0.90, 'answers use the remaining central height');
      assert.ok(placed.optionGap >= 6 && placed.optionGap <= 24);
      assert.ok(layout.questionGap + inset <= 42, 'first card stays near the question');
      const top = placed.outerPadding + sizes.metadataHeight + 6 + placed.questionHeight + layout.questionGap + inset;
      const cards = Array.from({ length: rows }, (_, index) => ({ top: top + index * (placed.cardHeight + placed.optionGap), height: placed.cardHeight }));
      for (let index = 1; index < cards.length; index++) {
        const previous = cards[index - 1]!; const current = cards[index]!;
        assert.ok(Math.abs(current.top - previous.top - previous.height - placed.optionGap) < 1e-8);
      }
      const expectedBottom = layout.centerHeight - placed.outerPadding - inset
        - (word ? sizes.exampleHeight + 6 : 0) - (pairs ? sizes.pairStatusHeight + 6 : 0);
      assert.ok(Math.abs(cards.at(-1)!.top + placed.cardHeight - expectedBottom) < 1e-8);
    }
  }
});

test('growing answers and gaps preserve typography budgets and do not introduce ordinary scrolling', () => {
  for (const [width, height, scale] of [[360, 700, 1], [393, 740, 1], [412, 880, 1], [320, 480, 2]] as const) {
    const layout = lessonLayout(width, height, scale);
    const sizes = lessonComposition(layout, standardMetrics);
    const snapshot = structuredClone(sizes);
    for (const [pairs, word] of [[false, false], [false, true], [true, false]] as const) {
      const allowedPromptHeight = sizes.questionBodyHeight - (word ? sizes.exampleHeight + 6 : 0);
      const placed = exercisePlacement(layout, sizes, allowedPromptHeight, pairs, word);
      assert.ok(placed.canvasHeight <= sizes.canvasHeight + 1e-8);
      if (!sizes.scroll) assert.equal(placed.scroll, false);
      const minimumHeight = pairs ? sizes.pairHeight : sizes.cardHeight;
      assert.ok(placed.cardHeight >= minimumHeight - 1e-8);
      assert.ok(placed.cardHeight <= Math.max(minimumHeight, pairs ? 78 : 104));
      assert.deepEqual(sizes, snapshot);
    }
  }
});

test('additional height increases both card height and spacing, with comfortable caps on unusually tall viewports', () => {
  const placements = [700, 740, 880, 1200].map((height) => {
    const layout = lessonLayout(393, height, 1);
    return exercisePlacement(layout, lessonComposition(layout, standardMetrics), 72, false, false);
  });
  for (let index = 1; index < placements.length; index++) {
    assert.ok(placements[index]!.cardHeight >= placements[index - 1]!.cardHeight);
    assert.ok(placements[index]!.optionGap >= placements[index - 1]!.optionGap);
  }
  assert.equal(placements.at(-1)!.cardHeight, 104);
  assert.equal(placements.at(-1)!.optionGap, 24);
  assert.ok(placements.every((placed) => placed.outerPadding === 8 && !placed.scroll));
});

test('overflow keeps readable text, unchanged cards and minimal outer padding while allowing only the central canvas to grow', () => {
  const layout = lessonLayout(320, 480, 2);
  const sizes = lessonComposition(layout, { ...standardMetrics, answer: 160, prompt: 220 });
  const placed = exercisePlacement(layout, sizes, 220, false, false);
  assert.equal(placed.scroll, true);
  assert.equal(placed.outerPadding, layout.vertical);
  assert.equal(placed.promptTextHeight, 220);
  assert.equal(placed.cardHeight, sizes.cardHeight);
  assert.equal(placed.optionGap, layout.optionGap);
  assert.equal(placed.gridHeight, 4 * sizes.cardHeight + 3 * layout.optionGap);
  assert.ok(placed.canvasHeight > layout.centerHeight);
  assert.equal(layout.headerHeight, lessonLayout(320, 480, 2).headerHeight);
  assert.equal(layout.footerHeight, lessonLayout(320, 480, 2).footerHeight);
});
