import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { Lesson, Source } from '../../../src/domain/content.ts';
import { useContent } from '../../../src/data/runtime.tsx';
import { Action, Copy, Heading, Page, useColors } from '../../../src/ui/common.tsx';
import { PrimaryAction, WordList } from '../../../src/ui/lesson.tsx';
import { lessonsCount, wordsCount } from '../../../src/ui/russian.ts';

export default function ChapterScreen() {
  const { productId, sectionId } = useLocalSearchParams<{ productId: string; sectionId: string }>();
  const { repository, learning, revision } = useContent();
  const colors = useColors();
  const [source, setSource] = useState<Source | null>(null);
  const [completed, setCompleted] = useState(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [words, setWords] = useState<Lesson | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true;
    setExpanded(null); setWords(null); setError(null); setLoading(true);
    void Promise.all([repository.document(productId, sectionId === 'movie' ? null : sectionId), learning.completed(productId)])
      .then(([document, results]) => { if (live) { setSource(document); setCompleted(results); } })
      .catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : 'Не удалось открыть главу.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [productId, sectionId, repository, learning, revision]));
  function open(lessonId: string, repeat = false) {
    router.push({ pathname: '/lessons/[productId]/[lessonId]', params: { productId, lessonId, ...(repeat ? { mode: 'repeat' } : {}) } });
  }
  const first = source?.lessons.find((lesson) => !completed.has(lesson.id));
  return <Page>{error ? <Copy>{error}</Copy> : source ? <>
    <Text style={{ color: colors.accent, letterSpacing: 1.2, fontSize: 12, fontWeight: '700' }}>ВАША ПРОБНАЯ ЧАСТЬ</Text>
    <Heading>{source.title.ru}</Heading><Copy>{lessonsCount(source.lessons.length)} · {wordsCount(source.lessons.length * 5)}</Copy>
    <Text style={{ color: colors.muted, fontSize: 16 }}>Пройдено: {source.lessons.filter((lesson) => completed.has(lesson.id)).length} из {source.lessons.length}</Text>
    {source.lessons.map((lesson) => {
      const done = completed.has(lesson.id);
      const available = done || first?.id === lesson.id;
      return <View key={lesson.id} style={{ borderRadius: 20, backgroundColor: colors.card, borderWidth: 1, borderColor: available ? colors.accent : colors.line, overflow: 'hidden' }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Урок ${lesson.position}${done ? ', пройдено' : available ? ', доступен' : ', сначала предыдущий урок'}`}
          onPress={() => done ? setExpanded(expanded === lesson.id ? null : lesson.id) : available ? open(lesson.id)
            : Alert.alert('Уроки по порядку', `Сначала завершите урок ${first?.position ?? 1}.`)} style={{ padding: 22, gap: 8 }}>
          <Text style={{ color: available ? colors.accent : colors.muted, fontSize: 23, fontWeight: '600' }}>Урок {lesson.position}</Text>
          <Text style={{ color: colors.muted, fontSize: 16 }}>{done ? 'Пройдено' : available ? '5 слов · Начать занятие →' : 'Следующий шаг'}</Text>
        </Pressable>
        {expanded === lesson.id && <View style={{ padding: 18, paddingTop: 0, gap: 10 }}>
          <PrimaryAction label="↻ Повторить" onPress={() => open(lesson.id, true)} />
          <Action label="Слова" onPress={() => setWords(lesson)} />
        </View>}
      </View>;
    })}
    <Modal visible={words !== null} transparent animationType="slide" onRequestClose={() => { setWords(null); setExpanded(null); }}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#00000077' }}>
        <View accessibilityViewIsModal style={{ maxHeight: '85%', borderRadius: 24, padding: 24, backgroundColor: colors.card, gap: 16 }}>
          <Heading>Слова урока</Heading><ScrollView style={{ flexShrink: 1 }}>{words && <WordList items={words.items} />}</ScrollView>
          <PrimaryAction label="Закрыть" onPress={() => { setWords(null); setExpanded(null); }} />
        </View>
      </View>
    </Modal>
  </> : loading ? <><ActivityIndicator color={colors.accent} /><Copy>Открываем скачанную главу…</Copy></> : <Copy>Скачанная глава недоступна. Обновите материалы в настройках.</Copy>}</Page>;
}
