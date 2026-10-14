/**
 * 纯逻辑层：比较前后两次页面快照，决定该发哪些通知。
 *
 * 这里刻意不引用任何 chrome.* API，因此可以在 Node 下直接单元测试。
 * DOM 采集在 content.js，通知发送在 background.js。
 *
 * 快照（snapshot）形状：
 *   {
 *     ts: number,                  // 采集时间
 *     focused: boolean,            // dsh 页面所在标签页是否处于焦点
 *     visible: boolean,            // 标签页是否可见
 *     sessions: [{ key, title, state }],
 *     attention: { count, kinds }  // 需要用户介入的界面（授权 / 提问）
 *   }
 *
 * state 取值来自 dsh 的 StateDot：ongoing | done | idle | warning | error。
 */

/** 一个会话可能处于的状态。 */
export const SESSION_STATES = ["ongoing", "done", "idle", "warning", "error", "unknown"];

/** 通知相关的默认配置。 */
export const DEFAULT_CONFIG = {
  /** 任务开始运行时是否通知（默认关，避免噪音）。 */
  notifyStart: false,
  /** 任务运行结束（完成 / 回到空闲）时是否通知。 */
  notifyComplete: true,
  /** 出现需要用户介入的界面时是否通知。 */
  notifyNeedsInput: true,
  /** 出错 / 需要关注时是否通知。 */
  notifyError: true,
  /** true = 即使 dsh 页面在前台也通知；false = 只在你没盯着它时通知。 */
  notifyWhenFocused: false,
  /** 同一会话同一类事件的静默间隔，避免抖动刷屏。 */
  cooldownMs: 15000,
};

/** 把外部快照规整成可安全计算的形状。 */
export function normalizeSnapshot(raw) {
  const rawSessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
  const seen = new Set();
  const sessions = [];
  for (const item of rawSessions) {
    if (item === null || typeof item !== "object") continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    sessions.push({
      key,
      title: typeof item.title === "string" && item.title.trim().length > 0 ? item.title.trim() : key,
      state: SESSION_STATES.includes(item.state) ? item.state : "unknown",
    });
  }
  const rawKinds = Array.isArray(raw?.attention?.kinds) ? raw.attention.kinds : [];
  const kinds = [...new Set(rawKinds.filter((kind) => typeof kind === "string" && kind.length > 0))];
  const rawCount = Number(raw?.attention?.count);
  return {
    ts: Number.isFinite(raw?.ts) ? raw.ts : 0,
    focused: raw?.focused === true,
    visible: raw?.visible !== false,
    sessions,
    attention: {
      count: Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0,
      kinds,
    },
  };
}

/** 完成态用哪种措辞。 */
function completedMessage(state) {
  if (state === "done") return "任务已完成";
  if (state === "idle") return "任务已结束（等待输入）";
  return "任务状态已回到空闲";
}

/** 需要用户介入时的措辞。 */
function attentionMessage(kinds) {
  if (kinds.includes("question")) return "dsh 在等你的回答";
  if (kinds.includes("approval")) return "dsh 在等你的授权";
  return "dsh 需要你的确认";
}

/**
 * 计算本次快照相对上次快照应当发出的通知。
 *
 * @param prevRaw - 上一次快照；首次运行时为 null（首次观测不发通知，避免打开页面就误报）。
 * @param nextRaw - 本次快照。
 * @param configRaw - 配置覆盖项（与 {@link DEFAULT_CONFIG} 合并）。
 * @param now - 当前时间戳（毫秒），由调用方注入以便测试。
 * @param lastNotifiedIn - 上一次通知时间，键为 `key:kind`；由调用方持久化。
 * @returns `{ events, lastNotified }`，events 为空表示本次不发通知。
 */
export function decide(prevRaw, nextRaw, configRaw, now, lastNotifiedIn) {
  const config = { ...DEFAULT_CONFIG, ...(configRaw ?? {}) };
  const prev = prevRaw === null || prevRaw === undefined ? null : normalizeSnapshot(prevRaw);
  const next = normalizeSnapshot(nextRaw);
  const lastNotified = new Map(lastNotifiedIn ?? []);
  const events = [];

  // 用户正盯着 dsh 页面时默认不打扰。
  const mayNotify = config.notifyWhenFocused === true || next.focused !== true;
  if (!mayNotify) return { events: [], lastNotified };

  const emit = (kind, key, title, message) => {
    const cooldownKey = `${key}:${kind}`;
    const last = lastNotified.get(cooldownKey);
    if (typeof last === "number" && now - last < config.cooldownMs) return;
    lastNotified.set(cooldownKey, now);
    events.push({ kind, key, title, message });
  };

  // 首次观测只建立基线，不通知。
  if (prev !== null) {
    const before = new Map(prev.sessions.map((session) => [session.key, session]));
    for (const session of next.sessions) {
      const was = before.get(session.key);
      if (was === undefined || was.state === session.state) continue;
      const wasRunning = was.state === "ongoing";
      const nowRunning = session.state === "ongoing";

      if (config.notifyStart && nowRunning) {
        emit("started", session.key, session.title, "任务开始运行");
      }
      // 只有正常收尾才算「完成」；出错 / 需要关注走下面那条，避免一次变化发两条通知。
      const normalFinish = session.state === "done" || session.state === "idle";
      if (config.notifyComplete && wasRunning && normalFinish) {
        emit("completed", session.key, session.title, completedMessage(session.state));
      }
      if (config.notifyError && (session.state === "error" || session.state === "warning")) {
        emit("error", session.key, session.title, session.state === "error" ? "任务执行出错" : "任务需要关注");
      }
    }

    // 需要用户介入：从无到有，或新增了一处。
    const appeared = next.attention.count > 0 && prev.attention.count === 0;
    const increased = next.attention.count > prev.attention.count;
    if (config.notifyNeedsInput && (appeared || increased)) {
      const kind = next.attention.kinds[0] ?? "attention";
      emit("needs-input", `attention:${kind}`, "dsh 等待你的操作", attentionMessage(next.attention.kinds));
    }
  }

  return { events, lastNotified };
}

/** 把 Map 形式的通知时间转成可持久化的数组。 */
export function serializeLastNotified(map) {
  return [...(map ?? new Map())].filter(([, at]) => typeof at === "number");
}
