/**
 * 主题控制：把用户的种子色与明暗偏好落到页面上。
 *
 * 分工是这样：
 *   - 颜色本身由 md3-tokens.js 从种子色算出来；
 *   - 明暗由 resolveMode() 决定（auto 时跟随系统）；
 *   - 默认种子色直接用 md3-palette.css 里的静态配色（首帧不闪）；
 *   - 只有用户自定义了种子色，才写内联 CSS 变量去覆盖。
 */
import { DEFAULT_SEED, resolveMode, scheme, schemeToCssVars } from "./md3-tokens.js";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 默认外观：Material You 基线紫 + 跟随系统。 */
export const DEFAULT_THEME = { seed: DEFAULT_SEED, mode: "auto" };

/** 规范化种子色，非法值退回默认。 */
export function normalizeSeed(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : DEFAULT_SEED;
}

/** 读取已保存的外观设置。 */
export async function readTheme() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw = stored?.[STORAGE_KEY] ?? {};
    return {
      seed: normalizeSeed(raw.seed),
      mode: ["auto", "light", "dark"].includes(raw.mode) ? raw.mode : DEFAULT_THEME.mode,
    };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

/** 保存外观设置（增量）。 */
export async function writeTheme(patch) {
  const current = await readTheme();
  const next = { ...current, ...patch };
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch {
    /* 存储不可用时至少让本次渲染生效 */
  }
  applyTheme(next);
  return next;
}

let appliedVars = [];

/**
 * 应用外观。
 *
 * 会显式设置 `data-theme`，这样静态配色的媒体查询不会和用户选择打架；
 * 自定义种子色则通过内联变量覆盖。
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  const prefersDark = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : false;
  const mode = resolveMode(theme?.mode, prefersDark);
  root.dataset.theme = mode;

  const seed = normalizeSeed(theme?.seed);
  for (const name of appliedVars) root.style.removeProperty(name);
  appliedVars = [];

  if (seed === DEFAULT_SEED) return; // 静态配色就是默认种子，无需内联覆盖

  const vars = schemeToCssVars(scheme(seed, mode === "dark"));
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  appliedVars = Object.keys(vars);
}

/**
 * 订阅外观变化：存储变更（另一个页面改了）与系统深浅色切换。
 * @param onApplied - 每次重新应用后回调，便于页面同步自己的控件状态。
 * @returns 取消订阅函数。
 */
export function watchTheme(onApplied) {
  const media = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
  const reapply = async () => {
    const theme = await readTheme();
    applyTheme(theme);
    onApplied?.(theme);
  };
  const onStorage = (changes, area) => {
    if (area === "local" && changes[STORAGE_KEY] !== undefined) void reapply();
  };
  const onMedia = () => void reapply();

  try {
    chrome.storage.onChanged.addListener(onStorage);
  } catch {
    /* 忽略 */
  }
  media?.addEventListener("change", onMedia);

  return () => {
    try {
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {
      /* 忽略 */
    }
    media?.removeEventListener("change", onMedia);
  };
}

/** 页面启动时调用：先读后应用，再开始订阅。 */
export async function initTheme(onApplied) {
  const theme = await readTheme();
  applyTheme(theme);
  onApplied?.(theme);
  return watchTheme(onApplied);
}
