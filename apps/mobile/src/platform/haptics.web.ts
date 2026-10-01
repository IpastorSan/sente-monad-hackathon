/**
 * Web twin of `haptics.ts`: the same calls, inert (SEN-164).
 *
 * The constants carry `expo-haptics`' own string values so a call site reads
 * identically on both platforms; the functions resolve immediately, so the
 * callers' `void` and `.catch` stay correct.
 */

export const ImpactFeedbackStyle = {
  Light: 'light',
  Medium: 'medium',
  Heavy: 'heavy',
  Soft: 'soft',
  Rigid: 'rigid',
} as const;
export type ImpactFeedbackStyle = (typeof ImpactFeedbackStyle)[keyof typeof ImpactFeedbackStyle];

export const NotificationFeedbackType = {
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
} as const;
export type NotificationFeedbackType =
  (typeof NotificationFeedbackType)[keyof typeof NotificationFeedbackType];

export async function selectionAsync(): Promise<void> {}

export async function impactAsync(_style?: ImpactFeedbackStyle): Promise<void> {}

export async function notificationAsync(_type?: NotificationFeedbackType): Promise<void> {}
