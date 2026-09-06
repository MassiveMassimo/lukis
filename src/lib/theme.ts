export type Theme = "system" | "light" | "dark";
const STORAGE_KEY = "lukis:theme:v1";
const CHANGE_EVENT = "lukis-theme-change";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
let transitionTimeout: ReturnType<typeof setTimeout> | undefined;

function asTheme(value: string | null | undefined): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

function readPreference(): Theme {
  try {
    return asTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme, animate = true) {
  const resolved =
    theme === "system" ? (window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light") : theme;
  const root = document.documentElement;
  if (!root.classList.contains(resolved)) {
    clearTimeout(transitionTimeout);
    root.classList.remove("theme-transitioning");
    if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.classList.add("theme-transitioning");
      // Install the color transition before swapping the theme.
      void root.offsetHeight;
      transitionTimeout = setTimeout(() => root.classList.remove("theme-transitioning"), 200);
    }
  }
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.dataset.theme = theme;
  root.style.colorScheme = resolved;
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* The page still works when browser storage is unavailable. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeTheme(notify: () => void) {
  const media = window.matchMedia(MEDIA_QUERY);
  const onSystemChange = () => {
    applyTheme(asTheme(document.documentElement.dataset.theme));
    notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    applyTheme(readPreference());
    notify();
  };
  applyTheme(asTheme(document.documentElement.dataset.theme), false);
  media.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, notify);
  return () => {
    media.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, notify);
  };
}

export function getThemeSnapshot() {
  const root = document.documentElement;
  return `${asTheme(root.dataset.theme)}:${root.classList.contains("dark") ? "dark" : "light"}`;
}

// Runs before paint. Keep preference validation aligned with asTheme.
export const THEME_SCRIPT = `(function(){var t="system";try{var s=localStorage.getItem("${STORAGE_KEY}");if(s==="light"||s==="dark")t=s}catch(e){}var r=document.documentElement;var v=t==="system"?(matchMedia("${MEDIA_QUERY}").matches?"dark":"light"):t;r.classList.remove("light","dark");r.classList.add(v);r.dataset.theme=t;r.style.colorScheme=v})()`;
