import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { transpileModule, JsxEmit, ModuleKind } from 'typescript';
import { fixture } from './fixtures.ts';
import { alerts, rendered, flattenStyle, type NativeRecord } from './native-ui.ts';
import { LessonRun } from '../src/domain/lesson-run.ts';
import { currentTask } from '../src/domain/lesson.ts';
import { emptyMinimumSizes, exercisePlacement, fontCandidates, lessonComposition, lessonLayout, type TextBox } from '../src/ui/lesson-layout.ts';
import { sampleKey, type TextSample } from '../src/ui/lesson-measurements.ts';
import { lessonsCount, sectionsCount, wordsCount } from '../src/ui/russian.ts';
import type { ChoiceTask, PairsTask } from '../src/domain/lesson.ts';

// Node's native TS support does not parse JSX. Use the existing TypeScript and
// React DOM dependencies; replace only native hosts, not the lesson components.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'react-native'
      ? { url: new URL('./native-ui.ts', import.meta.url).href, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(new URL('../src/ui/', import.meta.url).href) && url.endsWith('.tsx')) {
      return { format: 'module', shortCircuit: true, source: transpileModule(readFileSync(fileURLToPath(url), 'utf8'),
        { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext } }).outputText };
    }
    return next(url, context);
  },
});
const { ChoiceExercise, PairsExercise, WordExample } = await import('../src/ui/lesson.tsx');
const { LessonFrame, LessonFooter } = await import('../src/ui/lesson-frame.tsx');
const { TextProbes } = await import('../src/ui/lesson-typography.tsx');
const { confirmLessonExit, shouldConfirmLessonExit } = await import('../src/ui/lesson-exit.ts');
hooks.deregister();
// react-dom/server is already installed for Expo Router; its optional TS types
// are not a project dependency. Narrow this one test-only, untyped module here.
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(node: ReactNode): string };

function render(node: ReactNode) {
  rendered.length = 0;
  const html = renderToStaticMarkup(node);
  return { html, nodes: [...rendered] };
}
function buttons(nodes: NativeRecord[]) {
  return nodes.filter((node) => node.type === 'native-pressable');
}
function geometry(node: NativeRecord) {
  const { backgroundColor, borderColor, opacity, ...style } = flattenStyle(node.props.style);
  return style;
}
async function longTask(): Promise<ChoiceTask> {
  const f = await fixture();
  const item = f.source.lessons[0]!.items[0]!;
  return { kind: 'choice', item, type: 'context_ru_to_en', corrective: false, question: {
    ...item.exercises.context_ru_to_en,
    prompt: 'Выберите предложение, которое верно передаёт смысл этой ситуации и сохраняет изучаемое выражение.',
    options: item.exercises.context_ru_to_en.options.map((option, index) => ({ ...option,
      text: `Option ${index + 1}: She decided to carry out the difficult plan before the meeting began.` })),
  } };
}
const sizes = [
  { name: 'compact', width: 320, height: 540, fontScale: 1 },
  { name: 'ordinary', width: 393, height: 740, fontScale: 1 },
  { name: 'tall', width: 412, height: 880, fontScale: 1 },
  { name: 'large system font', width: 360, height: 680, fontScale: 2 },
];

test('the screen exit handler keeps an unfinished attempt on Stay and leaves only after confirmation, without saving partial results', async () => {
  const f = await fixture();
  let saves = 0; let left = 0;
  const run = new LessonRun({ productId: f.source.product_id, revisionId: f.manifest.revision_id, source: f.source, lesson: f.source.lessons[0]! },
    'lesson', async () => { saves++; });
  const task = currentTask(run.session); assert.ok(task.kind === 'choice');
  await run.answer(task.question.correct_option_id); run.next();
  const session = structuredClone(run.session);
  assert.equal(shouldConfirmLessonExit(null, false), false);
  assert.equal(shouldConfirmLessonExit(run, false), true);
  alerts.length = 0;
  confirmLessonExit(run, () => { left++; });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.title, 'Выйти из занятия?');
  const stay = alerts[0]!.buttons!.find((button) => button.text === 'Остаться')!;
  assert.equal(stay.style, 'cancel');
  stay.onPress?.();
  assert.equal(left, 0);
  assert.deepEqual(run.session, session);
  assert.equal(shouldConfirmLessonExit(run, false), true);
  confirmLessonExit(run, () => { left++; });
  alerts[1]!.buttons!.find((button) => button.text === 'Выйти')!.onPress!();
  assert.equal(left, 1);
  assert.equal(saves, 0);
  assert.equal(run.saveState, 'idle');
  assert.deepEqual(run.session, session);
});

test('the exit guard blocks leaving during final save and retry, and allows saved results, summary and finished repeat', async () => {
  const f = await fixture();
  const run = new LessonRun({ productId: f.source.product_id, revisionId: f.manifest.revision_id, source: f.source, lesson: f.source.lessons[0]! },
    'lesson', async () => {});
  while (!run.session.finished) {
    const task = currentTask(run.session);
    if (task.kind === 'choice') await run.answer(task.question.correct_option_id);
    else for (const item of task.left) { run.pair('left', item.id); run.pair('right', item.id); }
    if (!run.session.finished) run.next();
  }
  let left = 0;
  for (const state of ['saving', 'error'] as const) {
    run.saveState = state;
    assert.equal(shouldConfirmLessonExit(run, false), true);
    alerts.length = 0;
    confirmLessonExit(run, () => { left++; });
    assert.equal(alerts[0]!.title, 'Сохраняем результат');
    assert.equal(alerts[0]!.buttons, undefined);
    assert.ok(alerts[0]!.message!.includes(state === 'error' ? 'Повторите запись' : 'Подождите'));
  }
  assert.equal(left, 0);
  assert.equal(shouldConfirmLessonExit(run, true), false);
  run.saveState = 'saved';
  assert.equal(shouldConfirmLessonExit(run, false), false);
  const repeat = new LessonRun(run.context, 'repeat', async () => { throw new Error('Repeat must not save'); });
  assert.equal(shouldConfirmLessonExit(repeat, false), true);
  while (!repeat.session.finished) {
    const task = currentTask(repeat.session); assert.ok(task.kind === 'choice');
    await repeat.answer(task.question.correct_option_id);
    if (!repeat.session.finished) repeat.next();
  }
  assert.equal(shouldConfirmLessonExit(repeat, false), false);
});

test('real choice UI stretches the answer container for short translations and long sentences without moving on feedback', async () => {
  const long = await longTask();
  const short: ChoiceTask = { ...long, type: 'word_to_translation', question: {
    ...long.item.exercises.word_to_translation, prompt: 'path',
    options: long.item.exercises.word_to_translation.options.map((option, index) => ({ ...option, text: ['путь', 'лес', 'дом', 'яма'][index]! })),
  } };
  for (const task of [short, long]) for (const size of sizes) {
    const layout = lessonLayout(size.width, size.height, size.fontScale);
    const composition = lessonComposition(layout, emptyMinimumSizes());
    const typography = { promptFont: 19, answerFont: 18 };
    let selectedId: string | null = null;
    const placement = exercisePlacement(layout, composition, task === short ? 38 : 72, false, task === short);
    const draw = (selected: string | null) => render(createElement(ChoiceExercise, { task, selected, layout, composition, placement, typography, onAnswer: (id) => { selectedId = id; } }));
    const before = draw(null);
    const correct = draw(task.question.correct_option_id);
    const wrongId = task.question.options.find((option) => option.id !== task.question.correct_option_id)!.id;
    const wrong = draw(wrongId);
    for (const state of [before, correct, wrong]) {
      assert.equal(buttons(state.nodes).length, 4, size.name);
      for (const option of task.question.options) assert.ok(state.html.includes(option.text), size.name);
      for (const node of state.nodes.filter((entry) => entry.type === 'native-text')) {
        assert.equal(node.props.numberOfLines, undefined);
        assert.notEqual(node.props.adjustsFontSizeToFit, true);
        if (node.props.allowFontScaling === false) assert.ok(['✓', '×', ' '].includes(String(node.props.children)));
      }
      for (const node of state.nodes.filter((entry) => entry.type === 'native-view')) {
        const style = flattenStyle(node.props.style);
        assert.notEqual(style.justifyContent, 'space-between');
        assert.notEqual(style.marginTop, 'auto');
      }
      const region = state.nodes.find((node) => node.props.testID === 'answer-region')!;
      const regionStyle = flattenStyle(region.props.style);
      assert.equal(regionStyle.flex, 1, 'answers receive the remaining height');
      assert.equal(regionStyle.minHeight, placement.gridHeight, 'fallback cannot shrink or clip the cards');
      assert.equal(regionStyle.gap, placement.optionGap);
      assert.equal(regionStyle.justifyContent, 'center', 'only bounded surplus inside the answers is centred');
      assert.ok(buttons(state.nodes).every((node) => geometry(node).height === placement.cardHeight && geometry(node).flexShrink === 0));
    }
    const regions = (nodes: NativeRecord[]) => nodes.filter((node) => node.props.testID === 'question-region' || node.props.testID === 'answer-region').map(geometry);
    assert.deepEqual(regions(correct.nodes), regions(before.nodes));
    assert.deepEqual(regions(wrong.nodes), regions(before.nodes));
    assert.deepEqual(buttons(correct.nodes).map(geometry), buttons(before.nodes).map(geometry));
    assert.deepEqual(buttons(wrong.nodes).map(geometry), buttons(before.nodes).map(geometry));
    assert.ok(buttons(before.nodes).every((node) => node.props.disabled === false));
    assert.ok(buttons(correct.nodes).every((node) => node.props.disabled === true));
    assert.ok(buttons(wrong.nodes).every((node) => node.props.disabled === true));
    const onPress = buttons(before.nodes)[3]!.props.onPress;
    assert.equal(typeof onPress, 'function');
    if (typeof onPress === 'function') onPress();
    assert.equal(selectedId, task.question.options[3]!.id);
    const backgrounds = new Set(buttons(wrong.nodes).map((node) => flattenStyle(node.props.style).backgroundColor));
    assert.equal(backgrounds.size, 3); // correct, selected wrong, neutral
    assert.ok(buttons(before.nodes).every((node) => Number(geometry(node).height) >= 64));
    assert.equal(new Set(buttons(before.nodes).map((node) => geometry(node).height)).size, 1);
  }
});

test('header, scrollable centre and always-present footer are flex siblings in both lesson and short repeat', async () => {
  const task = await longTask();
  for (const size of sizes) for (const repeat of [false, true]) for (const feedback of [null, { correct: true }, { correct: false }]) {
    const layout = lessonLayout(size.width, size.height, size.fontScale);
    const selected = feedback ? task.question.options[0]!.id : null;
    const view = render(createElement(LessonFrame, { layout, value: 0.4, onClose: () => {}, contentKey: 0,
      footer: createElement(LessonFooter, { layout, feedback, pairs: false, waitingForSave: false, saveError: false, onContinue: () => {}, onRetry: () => {} }),
      children: [repeat ? 'Короткое повторение' : 'Урок 1', createElement(ChoiceExercise, { key: 'choice', layout, task, selected,
        composition: lessonComposition(layout, emptyMinimumSizes()), placement: exercisePlacement(layout, lessonComposition(layout, emptyMinimumSizes()), 72, false, false),
        typography: { promptFont: 19, answerFont: 18 }, onAnswer: () => {} })],
    }));
    assert.equal(view.nodes.filter((node) => node.type === 'native-scrollview').length, 1);
    assert.ok(view.html.indexOf('lesson-header') < view.html.indexOf('lesson-content'));
    assert.ok(view.html.indexOf('</native-scrollview>') < view.html.indexOf('lesson-footer'));
    const footer = view.nodes.find((node) => node.props.testID === 'lesson-footer')!;
    const center = view.nodes.find((node) => node.props.testID === 'lesson-content')!;
    assert.equal(flattenStyle(footer.props.style).flexShrink, 0);
    assert.equal(flattenStyle(center.props.style).flex, 1);
    assert.equal(flattenStyle(center.props.style).minHeight, 0);
    assert.ok(view.nodes.every((node) => flattenStyle(node.props.style).position !== 'absolute'));
    const action = buttons(view.nodes).at(-1)!;
    assert.equal(action.props.disabled, feedback === null);
  }
});

test('footer reserves the same status/action space and callbacks through feedback, saving and retry without a nested scroll', () => {
  const layout = lessonLayout(393, 740, 1);
  let continued = 0; let retried = 0;
  const cases = [
    { feedback: null, waitingForSave: false, saveError: false, disabled: true, label: 'Выберите ответ' },
    { feedback: { correct: true }, waitingForSave: false, saveError: false, disabled: false, label: 'Верно!' },
    { feedback: { correct: false }, waitingForSave: false, saveError: false, disabled: false, label: 'Неверно' },
    { feedback: { correct: true }, waitingForSave: true, saveError: false, disabled: true, label: 'Сохраняем' },
    { feedback: { correct: true }, waitingForSave: true, saveError: true, disabled: false, label: 'Не сохранено' },
  ];
  let initial: Record<string, unknown>[] | null = null;
  for (const state of cases) {
    const view = render(createElement(LessonFooter, { ...state, layout, pairs: false, onContinue: () => { continued++; }, onRetry: () => { retried++; } }));
    assert.ok(view.html.includes(state.label));
    assert.equal(view.nodes.filter((node) => node.type === 'native-scrollview').length, 0);
    const button = buttons(view.nodes)[0]!;
    assert.equal(button.props.disabled, state.disabled);
    const boxes = view.nodes.filter((node) => node.type === 'native-view' || node.type === 'native-pressable').map(geometry);
    if (initial) assert.deepEqual(boxes, initial); else initial = boxes;
    if (!state.disabled && typeof button.props.onPress === 'function') button.props.onPress();
  }
  assert.equal(continued, 2); assert.equal(retried, 1);
});

test('pairs retain ten full labels and card geometry after selection, mismatch and matched markers; word examples stay out of footer', async () => {
  const f = await fixture(); const items = f.source.lessons[0]!.items;
  const task: PairsTask = { kind: 'pairs', left: items, right: [...items].reverse() };
  const layout = lessonLayout(360, 680, 1.8);
  let initial: Record<string, unknown>[] | null = null;
  for (const state of [
    { left: null, right: null, wrong: false, matched: [] },
    { left: items[0]!.id, right: items[1]!.id, wrong: true, matched: [] },
    { left: null, right: null, wrong: false, matched: [items[0]!.id] },
    { left: null, right: null, wrong: false, matched: items.map((item) => item.id) },
  ]) {
    const view = render(createElement(PairsExercise, { task, layout, state, composition: lessonComposition(layout, emptyMinimumSizes()),
      placement: exercisePlacement(layout, lessonComposition(layout, emptyMinimumSizes()), 30, true, false),
      typography: { promptFont: 19, answerFont: 18 }, onSelect: () => {} }));
    assert.equal(buttons(view.nodes).length, 10);
    for (const item of items) { assert.ok(view.html.includes(item.en)); assert.ok(view.html.includes(item.ru)); }
    const boxes = buttons(view.nodes).map(geometry);
    if (initial) assert.deepEqual(boxes, initial); else initial = boxes;
    assert.ok(view.nodes.every((node) => node.props.numberOfLines === undefined));
    assert.ok(view.nodes.every((node) => flattenStyle(node.props.style).justifyContent !== 'space-between'));
  }
  const example = render(createElement(WordExample, { item: items[0]! }));
  assert.ok(example.html.includes(items[0]!.example.en[0]!.text));
  assert.equal(example.nodes.filter((node) => node.type === 'native-scrollview').length, 0);
});

test('Russian counts cover singular, few, many and teens, with material-specific chapter/episode labels', () => {
  for (const [count, expected] of [[0, '0 уроков'], [1, '1 урок'], [2, '2 урока'], [4, '4 урока'], [5, '5 уроков'],
    [11, '11 уроков'], [12, '12 уроков'], [14, '14 уроков'], [21, '21 урок'], [22, '22 урока'], [25, '25 уроков'], [101, '101 урок'], [111, '111 уроков']] as const) {
    assert.equal(lessonsCount(count), expected);
  }
  assert.equal(sectionsCount(1, 'book'), '1 глава'); assert.equal(sectionsCount(2, 'book'), '2 главы'); assert.equal(sectionsCount(11, 'book'), '11 глав');
  assert.equal(sectionsCount(1, 'season'), '1 эпизод'); assert.equal(sectionsCount(4, 'season'), '4 эпизода'); assert.equal(sectionsCount(21, 'season'), '21 эпизод');
  assert.equal(wordsCount(1), '1 слово'); assert.equal(wordsCount(2), '2 слова'); assert.equal(wordsCount(15), '15 слов');
});

test('word, phrase, both contexts and corrective questions keep their geometry when feedback and word examples are revealed', async () => {
  const f = await fixture(); const item = f.source.lessons[0]!.items[0]!;
  const layout = lessonLayout(393, 740, 1);
  const composition = lessonComposition(layout, { metadata: 18, heading: 18, prompt: 60, wordPrompt: 33, example: 84, answer: 60, pair: 20, pairStatus: 38 });
  for (const type of ['word_to_translation', 'context_ru_to_en', 'context_en_to_ru'] as const) for (const corrective of [false, true]) {
    const task: ChoiceTask = { kind: 'choice', type, corrective, item, question: item.exercises[type] };
    for (const prompt of [task.question.prompt, 'carry out']) {
      let original: Record<string, unknown>[] | null = null;
      const typography = { promptFont: fontCandidates([prompt])[0]!, answerFont: fontCandidates(task.question.options.map((option) => option.text))[0]! };
      const placement = exercisePlacement(layout, composition, 38, false, type === 'word_to_translation');
      for (const selected of [null, task.question.correct_option_id]) {
        const view = render(createElement(ChoiceExercise, { task: { ...task, question: { ...task.question, prompt } }, selected, composition, placement, typography, layout, onAnswer: () => {} }));
        const slots = view.nodes.filter((node) => node.props.testID === 'question-region' || node.props.testID === 'answer-region');
        const geometryNow = [...slots, ...buttons(view.nodes)].map(geometry);
        if (original) assert.deepEqual(geometryNow, original); else original = geometryNow;
        const answers = view.nodes.filter((node) => node.type === 'native-text' && task.question.options.some((option) => option.text === node.props.children));
        assert.equal(answers.length, 4);
        assert.equal(new Set(answers.map((node) => flattenStyle(node.props.style).fontSize)).size, 1);
        if (type === 'word_to_translation') {
          const example = view.nodes.find((node) => node.props.testID === 'word-example')!;
          assert.equal(flattenStyle(example.props.style).opacity, selected ? 1 : 0);
          assert.equal(example.props.accessibilityElementsHidden, !selected);
          assert.equal(flattenStyle(example.props.style).height, composition.exampleHeight);
        }
      }
    }
  }
});

test('native text probes measure real supplied line geometry at the card width and preserve Android font scaling without visual/accessibility overlays', () => {
  const sample: TextSample = { id: 'sample', text: 'A sentence whose wrapping is measured by native Android text layout.', font: 18, width: 275 };
  const received = new Map<string, TextBox>();
  const view = render(createElement(TextProbes, { samples: [sample], scale: 2, onMeasure: (key, box) => { received.set(key, box); } }));
  const container = view.nodes.find((node) => node.props.testID === 'text-probes')!;
  assert.equal(container.props.pointerEvents, 'none');
  assert.equal(container.props.importantForAccessibility, 'no-hide-descendants');
  assert.equal(flattenStyle(container.props.style).opacity, 0);
  const text = view.nodes.find((node) => node.type === 'native-text')!;
  assert.equal(text.props.allowFontScaling, true);
  assert.equal(text.props.numberOfLines, undefined);
  assert.equal(flattenStyle(text.props.style).width, 275);
  const measure = text.props.onTextLayout;
  assert.equal(typeof measure, 'function');
  if (typeof measure === 'function') measure({ nativeEvent: { lines: [{ y: 0, height: 24, width: 260 }, { y: 24, height: 24, width: 180 }] } });
  assert.deepEqual(received.get(sampleKey(sample, 2)), { width: 260, height: 48, lines: 2 });
  assert.equal(received.has(sampleKey(sample, 1)), false);
});
