import { Alert } from 'react-native';
import type { LessonRun } from '../domain/lesson-run.ts';

export function shouldConfirmLessonExit(run: LessonRun | null, summary: boolean): boolean {
  return run !== null && !summary && !(run.session.finished && (run.session.mode === 'repeat' || run.saveState === 'saved'));
}

export function confirmLessonExit(run: LessonRun, leave: () => void): void {
  if (run.session.finished && run.session.mode === 'lesson') {
    Alert.alert('Сохраняем результат', run.saveState === 'error'
      ? 'Не удалось сохранить результат. Повторите запись, прежде чем выйти.'
      : 'Подождите завершения записи на устройство.');
    return;
  }
  Alert.alert('Выйти из занятия?', 'Незавершённое занятие начнётся заново.', [
    { text: 'Остаться', style: 'cancel' },
    { text: 'Выйти', style: 'destructive', onPress: leave },
  ]);
}
