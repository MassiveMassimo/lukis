import { spring } from "motion";

const FALLBACK_DURATION_SECONDS = 0.3;
const FRAME_DURATION_MS = 1000 / 60;
const MAX_SPRING_DURATION_MS = 10_000;

export interface MotionTimingTransition {
  type?: string;
  visualDuration?: number;
  duration?: number;
  stiffness?: number;
  damping?: number;
  mass?: number;
  velocity?: number;
  restSpeed?: number;
  restDelta?: number;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function getTransitionDuration(
  transition: MotionTimingTransition | null | undefined,
  fallbackDuration = FALLBACK_DURATION_SECONDS,
) {
  if (finiteNonNegative(transition?.visualDuration)) {
    return transition.visualDuration;
  }

  if (transition?.type !== "spring" && finiteNonNegative(transition?.duration)) {
    return transition.duration;
  }

  if (transition?.type !== "spring") return fallbackDuration;

  const generator = spring({
    keyframes: [0, 1],
    stiffness: transition.stiffness,
    damping: transition.damping,
    mass: transition.mass,
    velocity: transition.velocity,
    restSpeed: transition.restSpeed,
    restDelta: transition.restDelta,
  });

  for (let elapsedMs = 0; elapsedMs <= MAX_SPRING_DURATION_MS; elapsedMs += FRAME_DURATION_MS) {
    if (generator.next(elapsedMs).done) return elapsedMs / 1000;
  }

  return MAX_SPRING_DURATION_MS / 1000;
}

export function getRevealTiming(
  boundsDuration: number,
  revealDuration: number,
  shouldReduceMotion = false,
) {
  if (shouldReduceMotion) return { delay: 0, duration: 0 };
  const duration = Math.min(boundsDuration, revealDuration);
  return { delay: boundsDuration - duration, duration };
}
