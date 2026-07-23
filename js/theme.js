// theme.js - resolve and apply the color theme. Single source of truth for how
// a preferred mode maps to the painted theme. "auto" follows local time.
//
// NOTE: index.html has a tiny inline copy of the auto/night rule so the theme is
// set before first paint (no flash). Keep the night window here and there in sync.

export const THEME_MODES = ["auto", "light", "dark"];

// Auto mode paints dark from NIGHT_START_HOUR until NIGHT_END_HOUR (local time).
const NIGHT_START_HOUR = 19; // 7pm
const NIGHT_END_HOUR = 7; // 7am

/** True when the given time falls in the dark-by-default night window. */
export function isNight(date = new Date()) {
  const h = date.getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

/** Map a preferred mode to the concrete theme to paint ("light" | "dark"). */
export function resolveTheme(mode, date = new Date()) {
  if (mode === "light" || mode === "dark") return mode;
  return isNight(date) ? "dark" : "light"; // auto
}

/** Paint the resolved theme onto <html data-theme>. Returns the resolved theme. */
export function applyTheme(mode, date = new Date()) {
  const theme = resolveTheme(mode, date);
  document.documentElement.dataset.theme = theme;
  return theme;
}

/** Next mode in the toggle cycle: auto -> light -> dark -> auto. */
export function nextThemeMode(mode) {
  const i = THEME_MODES.indexOf(mode);
  return THEME_MODES[(i + 1) % THEME_MODES.length];
}

/** Icon + text for the toggle button in a given mode. */
export function themeLabel(mode) {
  switch (mode) {
    case "light":
      return { icon: "\u2600\uFE0F", text: "Light" }; // sun
    case "dark":
      return { icon: "\u{1F319}", text: "Dark" }; // crescent moon
    default:
      return { icon: "\u{1F317}", text: "Auto" }; // half moon
  }
}
