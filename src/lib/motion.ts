import { cubicBezier } from "animejs";
import type { EasingConfig, TransitionConfig } from "dialkit/vanilla";

export const BOUNDS_TRANSITION = {
  type: "easing",
  duration: 1.2,
  ease: [0.6, -0.35, 0, 1],
} satisfies EasingConfig;
export const REVEAL_TRANSITION = {
  type: "easing",
  duration: 1.6,
  ease: [1 / 3, 1, 2 / 3, 1],
} satisfies EasingConfig;
export const HOVER_EASE = cubicBezier(0.175, 0.885, 0.32, 1.1);
export const MESSAGE_EASE = cubicBezier(0, 0, 0.58, 1);
export const FADE_EASE = cubicBezier(0.23, 1, 0.32, 1);
// A critically damped 300 ms icon spring, at 99.9% displacement by its end.
export const ICON_EASE = (t: number) =>
  t === 1 ? 1 : 1 - Math.exp(-9.233413476 * t) * (1 + 9.233413476 * t);
export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function getRevealTiming(boundsDuration: number, revealDuration: number, reduce = false) {
  if (reduce) return { delay: 0, duration: 0 };
  return { delay: Math.max(0, boundsDuration - revealDuration), duration: revealDuration };
}

export function getTransitionDuration(config: TransitionConfig) {
  if (config.type === "easing") return config.duration;
  if (config.visualDuration !== undefined) return config.visualDuration;
  return springTransition(config).duration / 1000;
}

// Solve a zero-velocity damped oscillator in seconds. Anime's spring parameter
// ranges and perceived duration differ from the saved reference. Feed its engine
// a custom curve so DialKit values retain their original meaning.
export function springTransition(
  config: Extract<TransitionConfig, { type: "spring" }>,
  { settle = false, distance = 1 } = {},
) {
  const visual = config.visualDuration;
  if (visual === 0) return { duration: 0, ease: (t: number) => t };
  const physical =
    config.stiffness !== undefined || config.damping !== undefined || config.mass !== undefined;
  const mass = config.mass ?? 1;
  const frequency =
    visual !== undefined && !physical
      ? (2 * Math.PI) / (visual * 1.2)
      : Math.sqrt((config.stiffness ?? 100) / mass);
  const ratio =
    visual !== undefined && !physical
      ? Math.max(0.05, Math.min(1, 1 - (config.bounce ?? 0)))
      : (config.damping ?? 10) / (2 * mass * frequency);
  const decay = ratio * frequency;
  const granular = Math.abs(distance) < 5;
  function sample(seconds: number) {
    const envelope = Math.exp(-decay * seconds);
    let displacement: number, speed: number;
    if (ratio < 1) {
      const oscillation = frequency * Math.sqrt(1 - ratio * ratio);
      const phase = oscillation * seconds;
      displacement = envelope * (Math.cos(phase) + (decay / oscillation) * Math.sin(phase));
      speed = envelope * ((frequency * frequency) / oscillation) * Math.sin(phase);
    } else if (ratio === 1) {
      displacement = envelope * (1 + frequency * seconds);
      speed = envelope * frequency * frequency * seconds;
    } else {
      const oscillation = frequency * Math.sqrt(ratio * ratio - 1);
      const phase = Math.min(oscillation * seconds, 300);
      displacement = envelope * (Math.cosh(phase) + (decay / oscillation) * Math.sinh(phase));
      speed = envelope * ((frequency * frequency) / oscillation) * Math.sinh(phase);
    }
    const done =
      Math.abs(speed * distance) <= (granular ? 0.01 : 2) &&
      Math.abs(displacement * distance) <= (granular ? 0.005 : 0.5);
    return { value: done ? 1 : 1 - displacement, done };
  }
  let duration = visual;
  if (duration === undefined || settle) {
    duration = 0;
    while (duration < 10 && !sample(duration).done) duration += 1 / 60;
  }
  const end = sample(duration).value;
  return {
    duration: duration * 1000,
    ease: (t: number) => (t === 1 ? 1 : end === 0 ? t : sample(t * duration).value / end),
  };
}

export function transition(config: TransitionConfig) {
  if (reducedMotion()) return { duration: 0, ease: (t: number) => t };
  if (config.type === "easing")
    return { duration: config.duration * 1000, ease: cubicBezier(...config.ease) };
  return springTransition(config);
}
