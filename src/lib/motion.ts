import { cubicBezier, spring } from "animejs";
import type { EasingConfig, TransitionConfig } from "dialkit/vanilla";

export const BOUNDS_TRANSITION = {
  type: "easing",
  duration: 1.2,
  ease: [0.6, -0.35, 0, 1],
} satisfies EasingConfig;
export const REVEAL_TRANSITION = {
  type: "easing",
  duration: 1,
  ease: [0.35, 0, 0, 1],
} satisfies EasingConfig;
export const HOVER_EASE = cubicBezier(0.175, 0.885, 0.32, 1.1);
export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function getRevealTiming(boundsDuration: number, revealDuration: number, reduce = false) {
  if (reduce) return { delay: 0, duration: 0 };
  const duration = Math.min(boundsDuration, revealDuration);
  return { delay: boundsDuration - duration, duration };
}

export function getTransitionDuration(config: TransitionConfig) {
  if (config.type === "easing") return config.duration;
  if (config.visualDuration !== undefined) return config.visualDuration;
  return (
    spring({ stiffness: config.stiffness, damping: config.damping, mass: config.mass }).duration /
    1000
  );
}

export function transition(config: TransitionConfig) {
  if (reducedMotion()) return { duration: 0, ease: (t: number) => t };
  if (config.type === "easing")
    return { duration: config.duration * 1000, ease: cubicBezier(...config.ease) };
  const easing = spring({
    stiffness: config.stiffness,
    damping: config.damping,
    mass: config.mass,
    ...(config.visualDuration === undefined
      ? {}
      : { duration: config.visualDuration * 1000, bounce: config.bounce ?? 0 }),
  });
  return { duration: easing.duration, ease: easing.ease };
}
