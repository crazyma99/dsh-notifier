/**
 * 内容脚本：只做「采集」，不做判断。
 *
 * 它在 dsh 页面里读取语义化 DOM 锚点，得到一个快照对象，推给 background 去比较和通知。
 * 选择器全部基于 dsh 前端里的语义标记（role / data-state / aria-label），而不是哈希类名：
 *   - 会话列表容器：  div[role="tree"][aria-label="会话" | "Sessions"]
 *   - 会话行：        [role="treeitem"]
 *   - 状态圆点：      span[data-state="ongoing|done|idle|warning|error"]
 *   - 状态文案：      行内 visually-hidden 的 span（"进行中"/"空闲"/"已完成" …）
 *   - 等待介入：      role="dialog|alertdialog|group" 内出现授权/提问关键词
 *
 * 这样即使 dsh 升级换掉样式类名，也仍然可用；真出问题时打开选项页的「页面调试浮层」即可看到采集结果。
 */
(() => {
  "use strict";

  const SESSION_STATES = new Set(["ongoing", "done", "idle", "warning", "error"]);

  const DEFAULT_LABELS = ["进行中", "空闲", "已完成", "Running", "Idle", "Completed"];
  const DEFAULT_ATTENTION_APPROVAL = [
    "允许一次",
    "允许",
    "拒绝",
    "批准",
    "Approve",
    "Reject",
    "Allow",
    "Deny",
  ];
  const DEFAULT_ATTENTION_QUESTION = ["请选择", "等待你的回答", "需要你的回答", "Choose an option"];
  const DEFAULT_ROW_SELECTOR = '[data-row-key^="session:"]';

  const CONFIG_DEFAULTS = {
    /** 当前配置要监听的地址；内容脚本据此判断"这个页面是不是我该管的"。 */
    baseUrl: "",
    pollMs: 3000,
    debug: false,
    sessionLabels: DEFAULT_LABELS,
    attentionApprovalTexts: DEFAULT_ATTENTION_APPROVAL,
    attentionQuestionTexts: DEFAULT_ATTENTION_QUESTION,
    sessionRowSelector: DEFAULT_ROW_SELECTOR,
  };

  /** @type {typeof CONFIG_DEFAULTS} */
  let config = { ...CONFIG_DEFAULTS };
  let lastSignature = "";
  let debugNode = null;
  let debugShadow = null;
  let stopped = false;

  /** 扩展被重载后，旧的 content script 会失去 runtime，此时应停止工作。 */
  function alive() {
    try {
      return !stopped && chrome.runtime?.id !== undefined;
    } catch {
      return false;
    }
  }

  function normalizeList(value, fallback) {
    if (Array.isArray(value)) {
      const cleaned = value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
      return cleaned.length > 0 ? cleaned : fallback;
    }
    if (typeof value === "string") {
      const cleaned = value
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return cleaned.length > 0 ? cleaned : fallback;
    }
    return fallback;
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get("config");
      const raw = stored?.config ?? {};
      config = {
        ...CONFIG_DEFAULTS,
        ...raw,
        pollMs: Number.isFinite(raw.pollMs) && raw.pollMs >= 500 ? raw.pollMs : CONFIG_DEFAULTS.pollMs,
        debug: raw.debug === true,
        sessionLabels: normalizeList(raw.sessionLabels, DEFAULT_LABELS),
        attentionApprovalTexts: normalizeList(raw.attentionApprovalTexts, DEFAULT_ATTENTION_APPROVAL),
        attentionQuestionTexts: normalizeList(raw.attentionQuestionTexts, DEFAULT_ATTENTION_QUESTION),
        sessionRowSelector: typeof raw.sessionRowSelector === "string" && raw.sessionRowSelector.trim().length > 0 ? raw.sessionRowSelector.trim() : DEFAULT_ROW_SELECTOR,
        baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "",
      };
    } catch {
      config = { ...CONFIG_DEFAULTS };
    }
  }

  /** 折叠空白并截断，避免把整行时间戳之类的东西塞进通知标题。 */
  const utils = globalThis.DshDomUtils ?? {
    collapse: (text) => String(text ?? "").replace(/\s+/g, " ").trim(),
    cleanTitle: (text) => String(text ?? "").replace(/\s+/g, " ").trim(),
  };

  function clean(text, limit = 80) {
    return utils.cleanTitle(text, limit);
  }

  /** 行内那个「进行中 / 空闲 / 已完成」的隐藏文本。 */
  function statusLabelOf(row) {
    for (const span of row.querySelectorAll("span")) {
      const text = (span.textContent ?? "").trim();
      if (text.length > 0 && config.sessionLabels.includes(text)) return text;
    }
    return "";
  }

  /**
   * 从一行的直接子元素里挑出标题。
   *
   * 会话行的结构是「状态槽位 + 标题 + 时间 + 置顶标记 + 行内操作菜单」，
   * 时间那一段是独立子元素，所以直接取"最长的那个子元素文本"就能拿干净标题，
   * 不必靠正则去尾部猜——dsh 的时间文案（`刚刚`/`2天`）变化时也不会失效。
   */
  function titleFromChildren(row) {
    let best = "";
    for (const child of row.children) {
      if (child.querySelector("[data-state]") !== null) continue; // 状态圆点槽位
      const text = (child.textContent ?? "").trim();
      if (text.length === 0 || config.sessionLabels.includes(text)) continue;
      if (text.length > best.length) best = text;
    }
    return best;
  }

  /** 会话标题：优先 aria-label，其次行内标题子元素，最后退回整行文本（并清掉尾部时间）。 */
  function titleOf(row, label) {
    const aria = row.getAttribute("aria-label");
    if (aria !== null && aria.trim().length > 0) return clean(aria) || "(未命名会话)";

    const fromChildren = titleFromChildren(row);
    if (fromChildren.length > 0) return clean(fromChildren) || "(未命名会话)";

    let text = row.innerText ?? "";
    if (label.length > 0) text = text.split(label).join(" ");
    return clean(text) || "(未命名会话)";
  }

  /** 一行会话的稳定标识：优先 dsh 自己的 data-row-key="session:<id>"。 */
  function sessionKeyOf(row, title) {
    const rowKey = row.getAttribute("data-row-key");
    if (rowKey !== null && rowKey.startsWith("session:")) return rowKey.slice("session:".length);
    const explicit = row.getAttribute("data-session-id");
    if (explicit !== null && explicit.length > 0) return explicit;
    return title;
  }

  /** 从一行里取状态。 */
  function stateOf(row) {
    const dot = row.querySelector("[data-state]");
    if (dot !== null) {
      const state = dot.getAttribute("data-state");
      if (SESSION_STATES.has(state)) return state;
    }
    // 关键：dsh 只在非 idle 时渲染状态圆点（showStatus = primaryStatus.state !== "idle"），
    // 所以「没有圆点」本身就是一个确定的信息：这一行是空闲的。
    return "idle";
  }

  /** 一行是否像"会话行"。 */
  function isSessionRow(row) {
    const rowKey = row.getAttribute("data-row-key");
    if (rowKey !== null && rowKey.startsWith("session:")) return true;
    const dot = row.querySelector("[data-state]");
    return dot !== null && SESSION_STATES.has(dot.getAttribute("data-state"));
  }

  /**
   * 采集会话行的候选，按可靠性从高到低兜底。
   *
   * 主锚点是 dsh 渲染在会话行上的 `data-row-key="session:<id>"`：它由会话 id 生成，
   * 不随样式类名、语言或布局变化，比 role / aria-label 稳得多
   * （踩过的坑：状态圆点只在非 idle 时渲染，按 aria-label="会话" 找容器也会漏）。
   */
  function candidateRows() {
    const selectors = [];
    if (typeof config.sessionRowSelector === "string" && config.sessionRowSelector.trim().length > 0) {
      selectors.push(config.sessionRowSelector.trim());
    }
    selectors.push('[data-row-key^="session:"]', '[role="treeitem"]');
    for (const selector of selectors) {
      let rows = [];
      try {
        rows = [...document.querySelectorAll(selector)];
      } catch {
        rows = [];
      }
      const usable = rows.filter(isSessionRow);
      if (usable.length > 0) return usable;
    }

    // 最后兜底：任何带状态的圆点，回溯到最近的"像一行"的祖先。
    // 用左半边屏幕作为约束，避免把对话流里的步骤圆点误当成会话。
    const rows = [];
    for (const dot of document.querySelectorAll("[data-state]")) {
      if (!SESSION_STATES.has(dot.getAttribute("data-state"))) continue;
      if (dot.closest("#dsh-notifier-debug") !== null) continue;
      if (dot.closest('[data-testid="todo-panel"]') !== null) continue;
      const rect = dot.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.5) continue;
      const row = dot.closest('[role="treeitem"], [data-row-key], li');
      if (row !== null) rows.push(row);
    }
    return rows;
  }

  /** 采集所有可见会话的状态。 */
  function collectSessions() {
    const sessions = [];
    const seen = new Set();
    for (const row of candidateRows()) {
      if (row.closest("#dsh-notifier-debug") !== null) continue;
      const label = statusLabelOf(row);
      const title = titleOf(row, label);
      const key = sessionKeyOf(row, title);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      sessions.push({ key, title, state: stateOf(row) });
    }
    return sessions;
  }

  /** 采集诊断信息：识别失败时用来定位是哪个假设不成立。 */
  function diagnose() {
    const count = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return -1;
      }
    };
    const sample = (selector, limit = 3) => {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(selector)].slice(0, limit);
      } catch {
        return [];
      }
      return nodes.map((node) => {
        const html = node.outerHTML ?? "";
        return html.length > 320 ? `${html.slice(0, 320)}…` : html;
      });
    };
    const trees = [];
    try {
      for (const tree of document.querySelectorAll('[role="tree"]')) {
        trees.push(`aria-label=${JSON.stringify(tree.getAttribute("aria-label"))} rows=${tree.querySelectorAll('[role="treeitem"]').length}`);
      }
    } catch {
      /* 忽略 */
    }
    return {
      url: location.href,
      origin: location.origin,
      title: document.title,
      locale: document.documentElement.lang || "(unset)",
      counts: {
        rowKeySession: count('[data-row-key^="session:"]'),
        rowKeyAny: count("[data-row-key]"),
        tree: count('[role="tree"]'),
        treeitem: count('[role="treeitem"]'),
        dataState: count("[data-state]"),
        todoPanel: count('[data-testid="todo-panel"]'),
      },
      trees,
      rowKeySamples: sample('[data-row-key^="session:"]'),
      dataStateSamples: (() => {
        try {
          return [...document.querySelectorAll("[data-state]")].slice(0, 8).map((node) => `${node.tagName.toLowerCase()}[data-state="${node.getAttribute("data-state")}"] in ${node.closest('[data-row-key], [role="treeitem"], li') === null ? "(no row)" : "row"}`);
        } catch {
          return [];
        }
      })(),
      detected: collectSnapshot(),
    };
  }

  /**
   * 采集需要用户介入的界面（授权确认、提问面板）。
   *
   * 判据刻意收紧为「关键词 + 界面里确实有可点的按钮」：只按 role="group" 全文匹配关键词时，
   * 聊天正文里出现「允许」「拒绝」这类词也会被误判成授权请求，而真正的授权/提问界面一定带按钮。
   */
  function collectAttention() {
    const keywords = [
      ...config.attentionApprovalTexts.map((text) => ({ kind: "approval", text })),
      ...config.attentionQuestionTexts.map((text) => ({ kind: "question", text })),
    ];
    const kinds = new Set();
    const surfaces = new Set();

    const matchingKind = (text) => {
      if (text.length === 0) return null;
      const hit = keywords.find((item) => text.includes(item.text));
      return hit === undefined ? null : hit.kind;
    };

    let containers = [];
    try {
      containers = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="group"]')];
    } catch {
      containers = [];
    }
    for (const container of containers) {
      const text = (container.innerText ?? "").slice(0, 4000);
      const kind = matchingKind(text);
      if (kind === null) continue;
      const hasButton = container.querySelector('button, [role="button"], [role="radio"]') !== null;
      if (!hasButton) continue;
      surfaces.add(container);
      kinds.add(kind);
    }

    // 兜底：授权界面的按钮自身就写着「允许一次 / 拒绝」，即使它不在上面那几种容器里。
    for (const surface of document.querySelectorAll('button, [role="button"]')) {
      const kind = matchingKind((surface.innerText ?? "").trim());
      if (kind === null) continue;
      const container = surface.closest('[role="dialog"], [role="alertdialog"], [role="group"]') ?? surface.parentElement ?? surface;
      surfaces.add(container);
      kinds.add(kind);
    }

    return { count: surfaces.size, kinds: [...kinds] };
  }

  function collectSnapshot() {
    return {
      // 来源标记：后台据此只接受"当前配置地址"的快照。
      // 同一台机器上可能同时开着多个 dsh（本地 127.x、服务器 42.x…），没有这个标记就会互相覆盖。
      origin: location.origin,
      url: location.href,
      ts: Date.now(),
      focused: typeof document.hasFocus === "function" ? document.hasFocus() : false,
      visible: document.visibilityState !== "hidden",
      sessions: collectSessions(),
      attention: collectAttention(),
    };
  }

  function signatureOf(snapshot) {
    const sessions = snapshot.sessions.map((item) => `${item.key}\u0001${item.state}`).join("\u0002");
    return [snapshot.focused ? "f" : "-", snapshot.visible ? "v" : "-", snapshot.attention.count, snapshot.attention.kinds.join("+"), sessions].join("\u0003");
  }

  function send(snapshot) {
    if (!alive()) return;
    try {
      const result = chrome.runtime.sendMessage({ type: "snapshot", snapshot });
      // MV3 里返回 Promise；没有接收方时会 reject，属于正常情况，静默即可。
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      /* 扩展上下文失效，忽略 */
    }
  }

  function refresh(force = false) {
    if (!alive() || !running) return;
    const snapshot = collectSnapshot();
    updateDebug(snapshot);
    const signature = signatureOf(snapshot);
    if (force || signature !== lastSignature) {
      lastSignature = signature;
      send(snapshot);
    }
  }

  //#region 调试浮层（Shadow DOM，避免与页面样式互相影响）
  function ensureDebug() {
    if (!config.debug) {
      if (debugNode !== null) {
        debugNode.remove();
        debugNode = null;
        debugShadow = null;
      }
      return false;
    }
    if (debugNode !== null && debugNode.isConnected) return true;
    debugNode = document.createElement("div");
    debugNode.id = "dsh-notifier-debug";
    debugNode.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;width:320px;pointer-events:none;";
    debugShadow = debugNode.attachShadow({ mode: "open" });
    debugShadow.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.box{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(15,23,42,.92);color:#e2e8f0;' +
      'border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:pre-wrap;word-break:break-all}' +
      '.k{color:#7dd3fc}' +
      '</style>' +
      '<div class="box"></div>';
    (document.body ?? document.documentElement).appendChild(debugNode);
    return true;
  }

  function updateDebug(snapshot) {
    if (!ensureDebug()) return;
    const box = debugShadow?.querySelector(".box");
    if (!box) return;
    if (snapshot === null) {
      box.textContent = [
        "dsh-notifier 已停用",
        `当前页面：${location.origin}`,
        `监听目标：${config.baseUrl.length > 0 ? config.baseUrl : "（未设置）"}`,
        "此页面不是被监听的地址，脚本已停止上报。",
      ].join("\n");
      return;
    }
    const lines = [
      `<span class="k">dsh-notifier</span> ${new Date(snapshot.ts).toLocaleTimeString()}`,
      `focused=${snapshot.focused} visible=${snapshot.visible}`,
      `sessions=${snapshot.sessions.length}`,
      ...snapshot.sessions.map((item) => `  • [${item.state}] ${item.title}`),
      `attention=${snapshot.attention.count} ${snapshot.attention.kinds.join(",")}`,
    ];
    box.innerHTML = lines.join("\n");
  }
  //#endregion

  //#region 触发时机：DOM 变更 + 心跳 + 焦点/可见性
  let throttled = null;
  function scheduleRefresh() {
    if (throttled !== null) return;
    throttled = setTimeout(() => {
      throttled = null;
      refresh(false);
    }, 400);
  }

  let observer = null;
  let heartbeat = null;
  let running = false;

  /**
   * 本页面是否就是当前配置要监听的那个地址。
   *
   * 这一条是"多个 dsh 同时打开"的关键：用户在设置页把地址从 A 改成 B 时，
   * A 页面里已经注入的脚本实例并不会被卸载（Chrome 不会撤销已注入的脚本），
   * 它若继续上报，就会和 B 的快照互相覆盖。
   * 所以脚本自己认领：不是配置的地址就彻底停下，连监听器都不留。
   */
  function selfMatchesConfig() {
    let target = null;
    try {
      target = new URL(config.baseUrl).origin;
    } catch {
      target = null;
    }
    return target !== null && location.origin === target;
  }

  function teardown() {
    running = false;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (throttled !== null) {
      clearTimeout(throttled);
      throttled = null;
    }
    observer?.disconnect();
    observer = null;
    updateDebug(null);
  }

  /** 心跳：即使页面没有 DOM 变更，也能把焦点切换等状态变化同步给后台。 */
  function scheduleHeartbeat() {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = setInterval(() => refresh(true), config.pollMs);
  }

  function start() {
    if (running) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", start, { once: true });
      return;
    }
    running = true;
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-label", "aria-current"],
    });

    scheduleHeartbeat();
    window.addEventListener("focus", () => refresh(true));
    window.addEventListener("blur", () => refresh(true));
    document.addEventListener("visibilitychange", () => refresh(true));

    refresh(true);
  }

  /** 依据配置决定启动还是停机；配置变化后调用。 */
  function sync() {
    if (selfMatchesConfig()) start();
    else teardown();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || changes.config === undefined) return;
    loadConfig().then(() => {
      lastSignature = "";
      if (selfMatchesConfig()) scheduleHeartbeat(); // 轮询间隔可能被改过
      sync();
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "diagnose") {
      try {
        const report = diagnose();
        report.listening = selfMatchesConfig();
        sendResponse({ ok: true, report });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
      return false;
    }
    return false;
  });

  window.addEventListener("pagehide", () => {
    stopped = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    if (throttled !== null) clearTimeout(throttled);
    observer?.disconnect();
  });

  loadConfig().then(sync);
})();
