type Forms = readonly [string, string, string];

export function counted(count: number, forms: Forms): string {
  const value = Math.abs(count);
  const last = value % 10;
  const tail = value % 100;
  const form = !Number.isInteger(value) ? forms[1]
    : tail >= 11 && tail <= 14 ? forms[2]
    : last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2];
  return `${count} ${form}`;
}

export const lessonsCount = (count: number) => counted(count, ['урок', 'урока', 'уроков']);
export const wordsCount = (count: number) => counted(count, ['слово', 'слова', 'слов']);
export const sectionsCount = (count: number, kind: 'book' | 'season') => counted(count,
  kind === 'book' ? ['глава', 'главы', 'глав'] : ['эпизод', 'эпизода', 'эпизодов']);
