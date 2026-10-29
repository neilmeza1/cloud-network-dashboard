// Light/dark toggle. Defaults to the system setting; a choice is remembered in the browser.
// Storage can be blocked (private windows, strict settings), so every access is guarded and
// the toggle still works for the current page without it.

const KEY = "cnd-theme";
const root = document.documentElement;
const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
const current = () => root.getAttribute("data-theme") || (systemDark() ? "dark" : "light");

function save(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* not remembered, still applied */ }
}

function label(btn) {
  const next = current() === "dark" ? "light" : "dark";
  btn.setAttribute("aria-label", `Switch to ${next} theme`);
  btn.querySelector(".theme-text").textContent = next === "dark" ? "Dark" : "Light";
}

export function initTheme(btn) {
  label(btn);
  btn.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    save(next);
    label(btn);
  });
  // Without a saved choice the page follows the system, so keep the label in step with it.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => label(btn));
}
