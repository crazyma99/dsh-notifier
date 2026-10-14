/**
 * Service worker：接收内容脚本的快照，比较状态变化并发出系统通知。
 *
 * chrome.notifications 由宿主操作系统渲染（Windows 通知中心 / Linux 通知守护 / macOS 通知中心），
 * 因此浏览器跑在哪个平台都能用，WSL 内部不需要任何桌面环境。
 */
import { DEFAULT_CONFIG, decide, serializeLastNotified } from "./decide.js";
import { acceptsSnapshot, normalizeIgnored, normalizeSnapshots, originOf } from "./sources.js";

const LAST_NOTIFIED_KEY = "lastNotified";
const CONFIG_KEY = "config";
/** 快照按 origin 分槽存放：多开 dsh 时互不覆盖。 */
const SNAPSHOTS_KEY = "snapshots";
/** 被拒绝的其它来源，仅用于弹窗里的诊断提示。 */
const IGNORED_KEY = "ignoredSources";

const BADGE_RUNNING = "#2563eb";
const BADGE_ATTENTION = "#dc2626";

/** 读取用户配置（写入侧在选项页 / 弹窗）。 */
async function readConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored?.[CONFIG_KEY] ?? {}) };
}

/** 读取上次通知时间（存在 storage.session，浏览器关闭即清空）。 */
async function readLastNotified() {
  try {
    const stored = await chrome.storage.session.get(LAST_NOTIFIED_KEY);
    const rows = Array.isArray(stored?.[LAST_NOTIFIED_KEY]) ? stored[LAST_NOTIFIED_KEY] : [];
    return new Map(rows.filter((row) => Array.isArray(row) && row.length === 2));
  } catch {
    return new Map();
  }
}

async function writeLastNotified(map) {
  try {
    await chrome.storage.session.set({ [LAST_NOTIFIED_KEY]: serializeLastNotified(map) });
  } catch {
    /* 忽略：session 存储不可用时只是少一层去重 */
  }
}

function notificationId(event, now) {
  return `dsh-${event.kind}-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 记录/清除"通知发不出去"的线索。
 *
 * 通知被系统或浏览器拦掉时，扩展这边是唯一能留下痕迹的地方：
 * 否则用户只会看到"什么都没发生"（macOS 上最常见的成因是系统设置里没给 Chrome 通知权限，
 * Windows 是"专注助手/通知"被关，Linux 是没有通知守护）。
 */
async function recordNotificationIssue(error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await chrome.storage.local.set({ notificationIssue: { message, at: Date.now() } });
  } catch {
    /* 记录失败就算了，不能因此影响主流程 */
  }
}

async function clearNotificationIssue() {
  try {
    await chrome.storage.local.set({ notificationIssue: null });
  } catch {
    /* 忽略 */
  }
}

/**
 * 发送一条系统通知。
 *
 * 关于平台差异（依据 Chrome 官方文档）：
 *   - NotificationButton.iconUrl 在 macOS 上不显示 → 这里只给按钮文字，不给图标；
 *   - appIconMaskUrl / imageUrl 在 macOS 上不显示 → 未使用；
 *   - items 在 macOS 上只显示第一项 → 未使用，正文走 message；
 *   - priority 取 -2/-1 在不支持通知中心的平台会直接报错 → 用 2（最高）。
 * 也就是说这里用到的字段没有任何一项带 macOS 排除说明。
 *
 * @returns 是否提交成功。注意"提交成功"不等于"一定显示"——系统仍可能静默丢弃。
 */
async function notify(event) {
  const buttons = event.kind === "needs-input" ? [{ title: "打开 dsh" }] : [];
  try {
    await chrome.notifications.create(notificationId(event, Date.now()), {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: event.title,
      message: event.message,
      contextMessage: "dsh",
      buttons,
      // 需要用户操作 / 出错时尽量保留在屏幕上，其它自动消失。
      requireInteraction: event.kind === "needs-input" || event.kind === "error",
      priority: 2,
      silent: false,
    });
    await clearNotificationIssue();
    return true;
  } catch (error) {
    await recordNotificationIssue(error);
    console.warn("[dsh-notifier] 通知发送失败：", error);
    return false;
  }
}

/** 徽标：有在跑的会话显示数量，有等待介入时显示红色感叹号。 */
async function updateBadge(snapshot) {
  const running = snapshot?.sessions?.filter((item) => item.state === "ongoing").length ?? 0;
  const attention = snapshot?.attention?.count ?? 0;
  try {
    if (attention > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_ATTENTION });
      await chrome.action.setBadgeText({ text: "!" });
    } else if (running > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_RUNNING });
      await chrome.action.setBadgeText({ text: String(running) });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    /* 忽略 */
  }
}

/** 点击通知 → 把 dsh 标签页切到前台。 */
async function focusDashboard() {
  const config = await readConfig();
  const baseUrl = typeof config.baseUrl === "string" && config.baseUrl.length > 0 ? config.baseUrl : "http://127.0.0.1:3080";
  try {
    const pattern = `${new URL(baseUrl).origin}/*`;
    const tabs = await chrome.tabs.query({ url: pattern });
    const tab = tabs[0];
    if (tab === undefined || tab.id === undefined) return;
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* 没找到标签页就什么都不做 */
  }
}

chrome.notifications.onClicked.addListener(() => {
  void focusDashboard();
});

chrome.notifications.onButtonClicked.addListener(() => {
  void focusDashboard();
});

const CONTENT_SCRIPT_ID = "dsh-watch";
const CONTENT_SCRIPT_FILES = ["src/dom-utils.js", "src/content.js"];

/**
 * 按已保存的地址重新注册内容脚本。
 *
 * 扩展重载或更新后，旧的注册仍指向旧文件列表（persistAcrossSessions 会保留），
 * 于是"改了内容脚本却没生效"会变成一个很隐蔽的坑。这里在安装/启动时按当前文件列表重新注册一次。
 * 未授权过的地址直接跳过——权限只能由用户在选项页点击申请。
 */
async function ensureRegistration() {
  const config = await readConfig();
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
  if (baseUrl.length === 0) return;
  try {
    const pattern = `${new URL(baseUrl).origin}/*`;
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) return;
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    } catch {
      /* 尚未注册过 */
    }
    await chrome.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        matches: [pattern],
        js: CONTENT_SCRIPT_FILES,
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  } catch (error) {
    console.warn("[dsh-notifier] 重新注册内容脚本失败：", error);
  }
}

/**
 * 清理旧设计留下的全局单槽。
 *
 * 早期版本把快照存在 lastSnapshot 这一个全局键里，多开 dsh 时会互相覆盖。
 * 现在按 origin 分槽存放，这两个键已经没有读者，留着只会让下次排查时误判。
 */
async function dropLegacyState() {
  try {
    await chrome.storage.local.remove(["lastSnapshot", "lastSnapshotAt"]);
  } catch {
    /* 忽略 */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void dropLegacyState();
  void ensureRegistration();
});
chrome.runtime.onStartup.addListener(() => {
  void dropLegacyState();
  void ensureRegistration();
});

/**
 * 处理内容脚本推送的快照。
 *
 * 两道关卡，缺一不可：
 *   1. 只接受来自"当前配置地址"的快照——旧地址页面里残留的脚本实例会继续上报，必须挡住；
 *   2. 基线按 origin 分槽保存——否则两个页面轮流上报时会互相顶掉基线，轻则弹窗闪烁，重则漏通知。
 */
async function handleSnapshot(snapshot) {
  const config = await readConfig();
  const target = originOf(config.baseUrl);
  const stored = await chrome.storage.local.get([SNAPSHOTS_KEY, IGNORED_KEY]);
  const snapshots = normalizeSnapshots(stored?.[SNAPSHOTS_KEY]);

  if (!acceptsSnapshot(snapshot, target)) {
    const ignored = normalizeIgnored(stored?.[IGNORED_KEY]);
    const origin = typeof snapshot?.origin === "string" && snapshot.origin.length > 0 ? snapshot.origin : "(未标记来源)";
    const entry = ignored[origin] ?? { count: 0, at: 0 };
    ignored[origin] = { count: entry.count + 1, at: Date.now() };
    await chrome.storage.local.set({ [IGNORED_KEY]: ignored });
    return { ok: false, reason: "foreign-origin", origin, target };
  }

  const previous = snapshots[target]?.snapshot ?? null;
  const now = Date.now();
  const lastNotified = await readLastNotified();

  const { events, lastNotified: nextLastNotified } = decide(previous, snapshot, config, now, lastNotified);

  snapshots[target] = { snapshot, at: now };
  const ignored = normalizeIgnored(stored?.[IGNORED_KEY]);
  delete ignored[target]; // 该地址已被接受，不需要再提示它被忽略过

  await chrome.storage.local.set({ [SNAPSHOTS_KEY]: snapshots, [IGNORED_KEY]: ignored });
  await writeLastNotified(nextLastNotified);
  await updateBadge(snapshot);

  for (const event of events) await notify(event);
  return { ok: true, notified: events.length };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "snapshot") {
    handleSnapshot(message.snapshot)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "test-notification") {
    // 如实回报：以前无论成败都回 ok，在排查"通知到底通不通"时正好会误导人
    notify({ kind: "needs-input", title: "dsh 任务状态通知", message: "这是一条测试通知，说明权限和系统通道都正常。" })
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "focus-dashboard") {
    focusDashboard().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
