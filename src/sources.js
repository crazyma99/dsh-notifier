/**
 * 数据来源（origin）判定与存储规整。
 *
 * 背景：用户可以同时打开多个 dsh（本地 127.x、服务器 42.x…），而扩展只应该信任**当前配置的那个地址**。
 * 这里把"来源"相关的判断集中成纯函数，便于单测，也避免后台/弹窗/设置页各写一套。
 *
 * 曾经的问题：快照只有一个全局槽位（lastSnapshot），后台也不看来源，
 * 于是旧地址页面里残留的内容脚本实例照样上报，把新地址的数据覆盖掉——表现就是弹窗内容"闪烁"，
 * 顺带还会吞掉通知（完成事件发生时基线刚好被另一个地址的快照顶掉了）。
 *
 * 存储形状（chrome.storage.local）：
 *   snapshots:      { "http://host:port": { snapshot, at } }
 *   ignoredSources: { "http://host:port": { count, at } }   // 被拒绝的其它来源，只用于诊断展示
 */

/** 从配置里的地址取出 origin；非法地址返回 null。 */
export function originOf(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * 该快照是否来自当前配置的地址。
 *
 * 没有来源标记的快照一律拒绝：那正是"扩展更新前注入、之后仍在运行"的旧实例，
 * 也正是造成串数据的那一类。
 */
export function acceptsSnapshot(snapshot, configuredOrigin) {
  if (typeof configuredOrigin !== "string" || configuredOrigin.length === 0) return false;
  const origin = snapshot !== null && typeof snapshot === "object" && typeof snapshot.origin === "string" ? snapshot.origin : null;
  if (origin === null || origin.length === 0) return false;
  return origin === configuredOrigin;
}

/** 规整 snapshots 存储，容忍损坏或历史数据。 */
export function normalizeSnapshots(raw) {
  const output = {};
  if (raw === null || typeof raw !== "object") return output;
  for (const [origin, value] of Object.entries(raw)) {
    if (origin.length === 0 || value === null || typeof value !== "object") continue;
    const snapshot = value.snapshot;
    if (snapshot === null || typeof snapshot !== "object") continue;
    output[origin] = {
      snapshot,
      at: Number.isFinite(value.at) ? value.at : 0,
    };
  }
  return output;
}

/** 取指定地址的快照记录；没有则返回 null。 */
export function recordFor(snapshots, origin) {
  if (typeof origin !== "string" || origin.length === 0) return null;
  const record = normalizeSnapshots(snapshots)[origin];
  if (record === undefined) return null;
  return { origin, snapshot: record.snapshot, at: record.at };
}

/** 规整 ignoredSources 存储。 */
export function normalizeIgnored(raw) {
  const output = {};
  if (raw === null || typeof raw !== "object") return output;
  for (const [origin, value] of Object.entries(raw)) {
    if (origin.length === 0 || value === null || typeof value !== "object") continue;
    const count = Number(value.count);
    output[origin] = {
      count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1,
      at: Number.isFinite(value.at) ? value.at : 0,
    };
  }
  return output;
}

/**
 * 最近仍在被拒绝的来源。
 *
 * 用来说明"为什么还有个页面在偷偷上报"——通常是因为那个标签页还开着旧脚本实例，
 * 刷新一次它就好了。
 * @param ignored - 规整后的 ignoredSources。
 * @param now - 当前时间。
 * @param maxAgeMs - 超过这个时长未再收到就认为已停止。
 */
export function recentIgnored(ignored, now, maxAgeMs = 60000) {
  return Object.entries(normalizeIgnored(ignored))
    .map(([origin, value]) => ({ origin, ...value }))
    .filter((entry) => now - entry.at <= maxAgeMs)
    .sort((a, b) => b.at - a.at);
}
