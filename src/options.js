/**
 * 选项页逻辑：保存配置 + 注册内容脚本 + 申请该地址的访问权限 + 外观设置。
 *
 * 关键点：Chrome 的 content script 匹配地址是静态的，不能由用户直接改，
 * 所以这里用 chrome.scripting.registerContentScripts 在运行时按「可配置 URL」注册，
 * 并且用 optional_host_permissions + permissions.request 在用户点击时申请授权。
 */
import { DEFAULT_CONFIG } from "./decide.js";
import { attachRipples, createSnackbar } from "./md3-controls.js";
import { SEED_PRESETS } from "./md3-tokens.js";
import { originOf } from "./sources.js";
import { initTheme, writeTheme } from "./theme.js";

const CONTENT_SCRIPT_ID = "dsh-watch";
const DEFAULT_BASE_URL = "http://127.0.0.1:3080";

const DEFAULT_LABELS = ["进行中", "空闲", "已完成", "Running", "Idle", "Completed"];
const DEFAULT_APPROVAL_TEXTS = ["允许一次", "允许", "拒绝", "批准", "Approve", "Reject", "Allow", "Deny"];
const DEFAULT_QUESTION_TEXTS = ["请选择", "等待你的回答", "需要你的回答", "Choose an option"];

const FIELD_DEFAULTS = {
  pollMs: 3000,
  debug: false,
  sessionRowSelector: '[data-row-key^="session:"]',
};

const el = (id) => document.getElementById(id);
const statusNode = el("status");
const snackbar = createSnackbar();

function setStatus(text, kind = "") {
  statusNode.textContent = text;
  if (kind.length > 0) statusNode.dataset.kind = kind;
  else delete statusNode.dataset.kind;
}

function parseList(value, fallback) {
  const items = String(value ?? "")
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : fallback;
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return DEFAULT_BASE_URL;
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  return url.origin;
}

function readForm() {
  return {
    baseUrl: normalizeBaseUrl(el("baseUrl").value),
    notifyStart: el("notifyStart").checked,
    notifyComplete: el("notifyComplete").checked,
    notifyNeedsInput: el("notifyNeedsInput").checked,
    notifyError: el("notifyError").checked,
    notifyWhenFocused: el("notifyWhenFocused").checked,
    cooldownMs: Math.max(0, Number(el("cooldownMs").value) || DEFAULT_CONFIG.cooldownMs),
    pollMs: Math.max(500, Number(el("pollMs").value) || FIELD_DEFAULTS.pollMs),
    debug: el("debug").checked,
    sessionRowSelector: el("sessionRowSelector").value.trim() || FIELD_DEFAULTS.sessionRowSelector,
    sessionLabels: parseList(el("sessionLabels").value, DEFAULT_LABELS),
    attentionApprovalTexts: parseList(el("attentionApprovalTexts").value, DEFAULT_APPROVAL_TEXTS),
    attentionQuestionTexts: parseList(el("attentionQuestionTexts").value, DEFAULT_QUESTION_TEXTS),
  };
}

function writeForm(config) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...FIELD_DEFAULTS,
    baseUrl: DEFAULT_BASE_URL,
    sessionLabels: DEFAULT_LABELS,
    attentionApprovalTexts: DEFAULT_APPROVAL_TEXTS,
    attentionQuestionTexts: DEFAULT_QUESTION_TEXTS,
    ...(config ?? {}),
  };
  el("baseUrl").value = merged.baseUrl;
  el("notifyStart").checked = merged.notifyStart === true;
  el("notifyComplete").checked = merged.notifyComplete !== false;
  el("notifyNeedsInput").checked = merged.notifyNeedsInput !== false;
  el("notifyError").checked = merged.notifyError !== false;
  el("notifyWhenFocused").checked = merged.notifyWhenFocused === true;
  el("cooldownMs").value = String(merged.cooldownMs);
  el("pollMs").value = String(merged.pollMs);
  el("debug").checked = merged.debug === true;
  el("sessionRowSelector").value = merged.sessionRowSelector;
  el("sessionLabels").value = merged.sessionLabels.join(", ");
  el("attentionApprovalTexts").value = merged.attentionApprovalTexts.join(", ");
  el("attentionQuestionTexts").value = merged.attentionQuestionTexts.join(", ");
}

//#region 外观（Material You 动态配色）
function renderTheme(theme) {
  el("seedColor").value = theme.seed;
  const preset = SEED_PRESETS.find((item) => item.hex.toLowerCase() === String(theme.seed).toLowerCase());
  el("seedValue").textContent = preset === undefined ? `${theme.seed} · 由它推导整套配色` : `${preset.name} · ${theme.seed}`;

  const modeInput = document.querySelector(`input[name="themeMode"][value="${theme.mode}"]`);
  if (modeInput !== null) modeInput.checked = true;

  for (const button of el("seedPresets").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.hex.toLowerCase() === String(theme.seed).toLowerCase() ? "true" : "false");
  }
}

function buildSeedPresets() {
  const container = el("seedPresets");
  container.textContent = "";
  for (const preset of SEED_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.dataset.hex = preset.hex;
    button.style.background = preset.hex;
    button.title = `${preset.name} ${preset.hex}`;
    button.setAttribute("aria-label", `${preset.name} ${preset.hex}`);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => void writeTheme({ seed: preset.hex }));
    container.appendChild(button);
  }
}

el("seedColor").addEventListener("input", (event) => {
  void writeTheme({ seed: event.target.value });
});

for (const input of document.querySelectorAll('input[name="themeMode"]')) {
  input.addEventListener("change", (event) => {
    if (event.target.checked === true) void writeTheme({ mode: event.target.value });
  });
}
//#endregion

/** 按配置的地址注册（或更新）内容脚本。 */
async function registerContentScript(baseUrl) {
  const pattern = `${baseUrl}/*`;
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) {
    const ok = await chrome.permissions.request({ origins: [pattern] });
    if (!ok) throw new Error(`未获得 ${pattern} 的访问权限，无法监听该地址`);
  }
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch {
    /* 尚未注册过 */
  }
  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      matches: [pattern],
      js: ["src/dom-utils.js", "src/content.js"],
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
  return pattern;
}

/**
 * 刷新已打开的 dsh 标签页，让内容脚本重新注入。
 *
 * 为什么要支持传多个地址：用户把监听地址从 A 改成 B 时，A 页面里**已经注入的旧脚本实例不会被卸载**，
 * 它会继续上报并和 B 互相覆盖（表现为弹窗内容闪烁、通知被吞）。所以换地址时必须把 A 也刷新一次。
 * @param baseUrls - 需要处理的地址（自动去重 origin）。
 * @returns 实际刷新的标签页数。
 */
async function reloadDashboardTabs(...baseUrls) {
  const origins = new Set();
  for (const value of baseUrls) {
    const origin = originOf(value);
    if (origin !== null) origins.add(origin);
  }
  let reloaded = 0;
  for (const origin of origins) {
    try {
      const tabs = await chrome.tabs.query({ url: `${origin}/*` });
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        await chrome.tabs.reload(tab.id);
        reloaded += 1;
      }
    } catch {
      /* 该地址没有权限或没有标签页：跳过 */
    }
  }
  return reloaded;
}

async function refreshSnapshotView() {
  const stored = await chrome.storage.local.get(["snapshots", "config", "notificationIssue"]);
  const issue = stored?.notificationIssue;
  const issueFresh = issue !== null && typeof issue === "object" && typeof issue.at === "number" && Date.now() - issue.at < 30 * 60 * 1000;
  const issueNote = issueFresh
    ? `⚠ 上次通知未能发出：${issue.message}（macOS 检查「系统设置 → 通知 → Google Chrome」；Windows 检查系统通知与专注助手；Linux 需要通知守护）`
    : "";
  // 只显示"当前配置地址"的快照，避免多开 dsh 时看到别的地址的内容
  const target = originOf(stored?.config?.baseUrl);
  const record = target === null ? null : stored?.snapshots?.[target] ?? null;
  const snapshot = record?.snapshot;
  if (snapshot === undefined || snapshot === null) {
    el("snapshot").textContent = "（还没有收到页面数据：确认地址正确、已保存启用，并刷新过 dsh 标签页）";
    return;
  }
  const when = record?.at ? new Date(record.at).toLocaleString() : "未知时间";
  el("snapshot").textContent = [
    `采集时间：${when}`,
    `页面聚焦：${snapshot.focused === true ? "是" : "否"}　可见：${snapshot.visible === false ? "否" : "是"}`,
    `会话数：${(snapshot.sessions ?? []).length}`,
    ...(snapshot.sessions ?? []).map((item) => `  · [${item.state}] ${item.title}`),
    `等待介入：${snapshot.attention?.count ?? 0} ${(snapshot.attention?.kinds ?? []).join(",")}`,
    ...(issueNote.length > 0 ? ["", issueNote] : []),
  ].join("\n");
}

async function init() {
  buildSeedPresets();
  const stored = await chrome.storage.local.get("config");
  writeForm(stored?.config);
  await refreshSnapshotView();
  await initTheme(renderTheme);
}

el("save").addEventListener("click", async () => {
  const button = el("save");
  button.disabled = true;
  setStatus("正在保存…");
  try {
    const previous = (await chrome.storage.local.get("config"))?.config?.baseUrl ?? "";
    const config = readForm();
    const pattern = await registerContentScript(config.baseUrl);
    await chrome.storage.local.set({ config });
    // 旧地址也要刷新：它的页面里可能还留着旧脚本实例，会与新地址互相覆盖
    const changed = originOf(previous) !== originOf(config.baseUrl);
    const reloaded = await reloadDashboardTabs(previous, config.baseUrl);
    setStatus(`已保存并监听 ${pattern}`, "ok");
    snackbar.show(
      reloaded > 0
        ? `已重载 ${reloaded} 个 dsh 标签页${changed ? "（含旧地址，已停止上报）" : ""}`
        : "请手动刷新 dsh 标签页使其生效",
    );
    await refreshSnapshotView();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`保存失败：${message}`, "err");
    snackbar.show("保存失败，详见页面提示");
  } finally {
    button.disabled = false;
  }
});

el("reloadTabs").addEventListener("click", async () => {
  try {
    const config = readForm();
    const reloaded = await reloadDashboardTabs(config.baseUrl);
    setStatus(reloaded > 0 ? `已重载 ${reloaded} 个标签页` : "没有找到打开该地址的标签页", reloaded > 0 ? "ok" : "err");
  } catch (error) {
    setStatus(`重载失败：${String(error)}`, "err");
  }
});

el("test").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "test-notification" });
    const ok = result?.ok === true;
    setStatus(ok ? "测试通知已发送" : "测试通知发送失败", ok ? "ok" : "err");
    snackbar.show(ok ? "测试通知已发送" : "测试通知发送失败");
  } catch (error) {
    setStatus(`测试通知发送失败：${String(error)}`, "err");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.snapshots !== undefined) {
    void refreshSnapshotView();
  }
});

attachRipples();
void init();
