/**
 * 弹窗逻辑：一眼看清当前状态，并能快速开关最重要的几个通知项。
 *
 * 状态呈现用 MD3 的 chip（运行中用主色容器 + 呼吸圆点），操作结果用 Snackbar。
 */
import { DEFAULT_CONFIG } from "./decide.js";
import { createSnackbar, attachRipples } from "./md3-controls.js";
import { originOf, recentIgnored, recordFor } from "./sources.js";
import { initTheme, writeTheme } from "./theme.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:3080";
const el = (id) => document.getElementById(id);
const snackbar = createSnackbar();

/** 会话状态 → chip 外观与文案。 */
const STATE_CHIP = {
  ongoing: { className: "md-chip--running", text: "运行中" },
  done: { className: "md-chip--done", text: "已完成" },
  idle: { className: "md-chip--idle", text: "空闲" },
  warning: { className: "md-chip--warning", text: "需要关注" },
  error: { className: "md-chip--error", text: "出错" },
  unknown: { className: "md-chip--idle", text: "未知" },
};

async function readConfig() {
  const stored = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, baseUrl: DEFAULT_BASE_URL, ...(stored?.config ?? {}) };
}

async function writeToggle(key, value) {
  const config = await readConfig();
  await chrome.storage.local.set({ config: { ...config, [key]: value } });
}

/** 构建一行会话：状态 chip + 标题。 */
function sessionRow(session) {
  const chip = STATE_CHIP[session.state] ?? STATE_CHIP.unknown;
  const item = document.createElement("li");
  item.className = "md-list-item";

  const badge = document.createElement("span");
  badge.className = `md-chip ${chip.className}`;
  const dot = document.createElement("span");
  dot.className = "md-chip__dot";
  const text = document.createElement("span");
  text.textContent = chip.text;
  badge.append(dot, text);

  const title = document.createElement("span");
  title.className = "md-list-item__text md-list-item__headline";
  title.textContent = session.title;
  title.title = session.title;

  item.append(badge, title);
  return item;
}

/** 构建一行提示文案（无数据 / 未识别）。 */
function placeholderRow(text) {
  const item = document.createElement("li");
  item.className = "md-list-item";
  const span = document.createElement("span");
  span.className = "md-list-item__text md-body-small md-muted";
  span.textContent = text;
  item.appendChild(span);
  return item;
}

async function render() {
  const config = await readConfig();
  const stored = await chrome.storage.local.get(["snapshots", "ignoredSources", "notificationIssue"]);
  // 只读"当前配置地址"那一槽：多开 dsh 时其它地址的数据不会串进来
  const target = originOf(config.baseUrl);
  const record = recordFor(stored?.snapshots, target);
  const snapshot = record?.snapshot ?? null;

  for (const key of ["notifyComplete", "notifyNeedsInput", "notifyError", "notifyStart"]) {
    el(key).checked = key === "notifyStart" ? config.notifyStart === true : config[key] !== false;
  }

  const age = typeof record?.at === "number" && record.at > 0 ? Math.round((Date.now() - record.at) / 1000) : null;
  el("pageStatus").textContent =
    snapshot === null ? `等待页面数据 · ${config.baseUrl}` : `${config.baseUrl} · ${age} 秒前更新`;

  const list = el("sessions");
  list.textContent = "";
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  if (sessions.length === 0) {
    list.appendChild(placeholderRow(snapshot === null ? "（还没有收到页面数据）" : "（未识别到会话行）"));
  } else {
    for (const session of sessions) list.appendChild(sessionRow(session));
  }

  const attention = snapshot?.attention?.count ?? 0;
  const kinds = (snapshot?.attention?.kinds ?? []).join("、");
  el("snapshot").textContent =
    snapshot === null
      ? "（还没有收到页面数据）"
      : `聚焦 ${snapshot.focused === true ? "是" : "否"} · 可见 ${snapshot.visible === false ? "否" : "是"} · 等待介入 ${attention}${kinds.length > 0 ? `（${kinds}）` : ""}`;

  // 解释"为什么刚才没收到通知"：默认在页面处于前台时不打扰，这一点不说明就很容易被当成故障
  const suppressed = snapshot?.focused === true && config.notifyWhenFocused !== true;
  const focusNote = el("focusNote");
  focusNote.hidden = !suppressed;
  focusNote.textContent = suppressed
    ? "dsh 页面正在前台：按当前设置不会打扰（可在设置里打开「即使我在看也通知」）。"
    : "";

  // 通知提交失败的线索（系统权限、专注模式等都会导致这种情况）
  const issue = stored?.notificationIssue;
  const issueNote = el("notifyIssue");
  const fresh = issue !== null && typeof issue === "object" && typeof issue.at === "number" && Date.now() - issue.at < 30 * 60 * 1000;
  issueNote.hidden = !fresh;
  issueNote.textContent = fresh
    ? `上次通知未能发出：${issue.message}。macOS 请检查「系统设置 → 通知 → Google Chrome」是否允许通知、是否开着专注模式；Windows 检查系统通知与专注助手；Linux 需要通知守护。`
    : "";

  // 若有其它地址的页面仍在上报，说明那里还留着旧脚本实例（刷新该标签页即可）
  const ignored = recentIgnored(stored?.ignoredSources, Date.now());
  const note = el("sourcesNote");
  if (ignored.length === 0) {
    note.hidden = true;
    note.textContent = "";
  } else {
    note.hidden = false;
    note.textContent = `已忽略 ${ignored.map((entry) => entry.origin).join("、")} 的上报：那不是当前监听的地址。刷新那些标签页即可停止。`;
  }
}

/** 外观分段按钮：读回当前选择，改动即存。 */
function renderTheme(theme) {
  const input = document.querySelector(`input[name="themeMode"][value="${theme.mode}"]`);
  if (input !== null) input.checked = true;
}

for (const key of ["notifyComplete", "notifyNeedsInput", "notifyError", "notifyStart"]) {
  el(key).addEventListener("change", (event) => {
    void writeToggle(key, event.target.checked);
  });
}

for (const input of document.querySelectorAll('input[name="themeMode"]')) {
  input.addEventListener("change", (event) => {
    if (event.target.checked === true) void writeTheme({ mode: event.target.value });
  });
}

el("test").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "test-notification" });
    snackbar.show(result?.ok === true ? "测试通知已发送" : "测试通知发送失败");
  } catch (error) {
    snackbar.show(`测试通知失败：${String(error)}`);
  }
});

el("diagnose").addEventListener("click", async () => {
  const config = await readConfig();
  const section = el("diagSection");
  const output = el("diag");

  let tab;
  try {
    const tabs = await chrome.tabs.query({ url: `${new URL(config.baseUrl).origin}/*` });
    tab = tabs[0];
  } catch {
    tab = undefined;
  }

  section.hidden = false;
  if (tab === undefined || tab.id === undefined) {
    output.textContent = `没有找到打开 ${config.baseUrl} 的标签页，请先打开 dsh 页面。`;
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "diagnose" });
    output.textContent =
      response?.ok === true
        ? JSON.stringify(response.report, null, 2)
        : `诊断失败：${response?.error ?? "未知错误"}（页面可能是在注册内容脚本之前打开的，刷新一下再试）`;
  } catch (error) {
    output.textContent = `无法与页面通信：${String(error)}\n页面可能是在注册内容脚本之前打开的，请刷新 dsh 标签页后重试。`;
  }
});

el("copyDiag").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(el("diag").textContent ?? "");
    snackbar.show("诊断信息已复制");
  } catch (error) {
    snackbar.show(`复制失败：${String(error)}`);
  }
});

el("open").addEventListener("click", async () => {
  const config = await readConfig();
  await chrome.tabs.create({ url: config.baseUrl });
});

el("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

attachRipples();
void initTheme(renderTheme);
void render();

// 页面对着 dsh 时快照会持续更新，这里跟着刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === "local" &&
    (changes.snapshots !== undefined || changes.ignoredSources !== undefined || changes.notificationIssue !== undefined)
  ) {
    void render();
  }
});
