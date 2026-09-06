import { animate } from "animejs";
import { FADE_EASE, ICON_EASE, reducedMotion } from "./motion";

/** Keep outgoing icons mounted until they finish, including interrupted swaps. */
export function createIconSwap() {
  const animations = new Map<HTMLElement, ReturnType<typeof animate>>();
  const selections = new Map<HTMLElement, boolean>();

  function select(icon: HTMLElement, selected: boolean, reducedDuration = 120) {
    if ((selections.get(icon) ?? !icon.hidden) === selected) return;
    selections.set(icon, selected);
    animations.get(icon)?.cancel();
    const reduce = reducedMotion();
    if (icon.hidden && selected) {
      Object.assign(icon.style, {
        opacity: "0",
        transform: reduce ? "scale(1)" : "scale(0.25)",
        filter: reduce ? "blur(0px)" : "blur(4px)",
      });
      icon.hidden = false;
    }
    animations.set(
      icon,
      animate(icon, {
        opacity: selected ? 1 : 0,
        scale: selected || reduce ? 1 : 0.25,
        filter: selected || reduce ? "blur(0px)" : "blur(4px)",
        duration: reduce ? reducedDuration : 300,
        ease: reduce ? FADE_EASE : ICON_EASE,
        onComplete: () => {
          icon.hidden = !selected;
          animations.delete(icon);
        },
      }),
    );
  }

  return {
    select,
    destroy() {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
      selections.clear();
    },
  };
}
