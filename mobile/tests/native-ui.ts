// Test host for rendering the real presentation components with React DOM's
// installed server renderer. This checks structure/props, not Android/Yoga pixels.
import { createElement, type ReactNode } from 'react';
import type { AlertButton } from 'react-native';

export const alerts: { title: string; message?: string; buttons?: AlertButton[] }[] = [];
export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]) { alerts.push({ title, message, buttons }); },
};

export type NativeRecord = { type: string; props: Record<string, unknown> };
export const rendered: NativeRecord[] = [];

export function flattenStyle(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return Object.assign({}, ...value.map(flattenStyle));
  return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

function host(type: string) {
  return function NativeHost(props: Record<string, unknown>) {
    const style = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
    rendered.push({ type, props: { ...props, style: flattenStyle(style) } });
    return createElement(type, { 'data-testid': props.testID }, props.children as ReactNode);
  };
}

export const View = host('native-view');
export const Text = host('native-text');
export const Pressable = host('native-pressable');
export const ScrollView = host('native-scrollview');
export const StyleSheet = { create: <T,>(styles: T): T => styles, hairlineWidth: 1 };
export const useColorScheme = () => 'dark';
