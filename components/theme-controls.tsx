"use client";

import { Button } from "@MassiveMassimo/ui";
import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import { play } from "cuelume";
import { DialRoot } from "dialkit";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useSyncExternalStore } from "react";
import {
  getServerThemeSnapshot,
  getThemeSnapshot,
  setTheme,
  subscribeTheme,
  type Theme,
} from "@/lib/theme";

const THEMES = {
  system: { label: "System", icon: IconDeviceDesktop, next: "light" },
  light: { label: "Light", icon: IconSun, next: "dark" },
  dark: { label: "Dark", icon: IconMoon, next: "system" },
} as const;

export function ThemeControls() {
  const snapshot = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);
  const [theme, resolved] = snapshot.split(":") as [Theme, "light" | "dark"];
  const reduceMotion = useReducedMotion();
  const { label, icon: Icon, next } = THEMES[theme];
  const description = `Theme: ${label}. Switch to ${THEMES[next].label}`;
  const hidden = {
    opacity: 0,
    transform: reduceMotion ? "scale(1)" : "scale(0.25)",
    filter: reduceMotion ? "blur(0px)" : "blur(4px)",
  };

  return (
    <>
      <div className="fixed bottom-4 left-4 z-50">
        <Button
          variant="ghost"
          size="icon"
          aria-label={description}
          title={description}
          onClick={() => setTheme(next)}
        >
          <span className="relative grid size-5 place-items-center" aria-hidden="true">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={theme}
                data-theme-icon={theme}
                className="col-start-1 row-start-1 grid size-5 place-items-center"
                initial={hidden}
                animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
                exit={hidden}
                transition={
                  reduceMotion ? { duration: 0.12 } : { type: "spring", duration: 0.3, bounce: 0 }
                }
              >
                <Icon size={18} strokeWidth={1.5} />
              </motion.span>
            </AnimatePresence>
          </span>
        </Button>
      </div>
      <DialRoot
        theme={resolved}
        onOpenChange={(open) => play(open ? "scan" : "droplet", { volume: 0.5 })}
      />
    </>
  );
}
