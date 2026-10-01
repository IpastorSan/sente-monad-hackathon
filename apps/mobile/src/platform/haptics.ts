/**
 * Haptic feedback: on Android this IS `expo-haptics`.
 *
 * On web, Metro picks `haptics.web.ts` instead, which does nothing. A desktop
 * browser has no haptics to give, and `expo-haptics`' own web build falls back
 * to `navigator.vibrate` or a hidden-checkbox click on iOS Safari — neither of
 * which a mouse-driven demo wants.
 *
 * Exposes only the calls the app makes; add one here (and to the web twin)
 * before using it. This is the only module that may import `expo-haptics`.
 */
export {
  ImpactFeedbackStyle,
  impactAsync,
  NotificationFeedbackType,
  notificationAsync,
  selectionAsync,
} from 'expo-haptics';
