import { animate, cubicBezier } from "animejs";
import { createIconSwap } from "./icon-swap";
import { reducedMotion } from "./motion";

/** Keep the label and dimensions stable while a native button is busy. */
export function setButtonLoading(button: HTMLButtonElement, loading: boolean): void {
  if ((button.dataset.loading === "true") === loading) return;

  if (loading) button.dataset.idleDisabled = String(button.disabled);
  button.dataset.loading = String(loading);
  button.disabled = loading || button.dataset.idleDisabled === "true";
  if (loading) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

export function createButtonFeedback(button: HTMLButtonElement) {
  const swap = createIconSwap();
  const icons = [...button.querySelectorAll<HTMLElement>("[data-button-icon]")];
  const check = button.querySelector<SVGPathElement>("[data-animated-check]")!;
  let checkAnimation: ReturnType<typeof animate> | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  function setState(state: "idle" | "loading" | "success") {
    clearTimeout(resetTimer);
    setButtonLoading(button, state === "loading");
    button.dataset.feedbackState = state;
    // Exports usually finish quickly. Keep the current icon while input is disabled.
    if (state === "loading") return;
    checkAnimation?.cancel();
    for (const icon of icons) swap.select(icon, icon.dataset.buttonIcon === state);
    if (state === "success") {
      // Draw once per success, never on hover. Preserve the source's two timings.
      checkAnimation = animate(check, {
        strokeDashoffset: reducedMotion() ? 0 : [1, 0],
        opacity: { from: reducedMotion() ? 1 : 0, to: 1, duration: reducedMotion() ? 0 : 200 },
        duration: reducedMotion() ? 0 : 400,
        ease: cubicBezier(0.42, 0, 0.58, 1),
      });
      resetTimer = setTimeout(() => setState("idle"), 1800);
    }
  }

  return {
    setState,
    destroy() {
      clearTimeout(resetTimer);
      checkAnimation?.cancel();
      swap.destroy();
    },
  };
}
