import type { PropsWithChildren } from 'react';
import { Pressable, ScrollView, Text, useColorScheme, View } from 'react-native';

export function useColors() {
  return useColorScheme() === 'dark'
    ? { background: '#12181d', card: '#202c33', text: '#f2f6f7', muted: '#b4c4cc', accent: '#7ce0ba' }
    : { background: '#f4f7f5', card: '#ffffff', text: '#162c28', muted: '#516861', accent: '#14664d' };
}

export function Page({ children }: PropsWithChildren) {
  const colors = useColors();
  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 40 }}>{children}</ScrollView>;
}

export function Heading({ children }: PropsWithChildren) {
  const colors = useColors();
  return <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 26, fontWeight: '700' }}>{children}</Text>;
}

export function Copy({ children }: PropsWithChildren) {
  const colors = useColors();
  return <Text style={{ color: colors.text, fontSize: 17, lineHeight: 26 }}>{children}</Text>;
}

export function Card({ children }: PropsWithChildren) {
  const colors = useColors();
  return <View style={{ backgroundColor: colors.card, borderRadius: 16, padding: 18, gap: 8 }}>{children}</View>;
}

export function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={{ borderWidth: 1, borderColor: colors.accent, borderRadius: 12, padding: 14, opacity: disabled ? 0.5 : 1 }}>
    <Text style={{ fontSize: 17, fontWeight: '600', color: colors.accent }}>{label}</Text>
  </Pressable>;
}
