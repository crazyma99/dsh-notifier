/**
 * 纯字符串工具：content.js 与单元测试共用同一份实现。
 *
 * 刻意写成经典脚本（挂到 globalThis）而不是 ESM：MV3 的内容脚本不能静态 import 扩展内的 ESM 模块。
 * 单元测试会把本文件读进 Node 里执行，所以测试覆盖的就是真正发布的那份代码。
 */
(() => {
  "use strict";

  /**
   * 相对时间后缀。
   *
   * 前两组是"带标记"的写法（`5分钟前` / `2 hours ago`），可以不要求前置空格。
   * 后三组对应 dsh 自己的时间格式——`刚刚` / `2天` / `2小时`（**不带"前"**），
   * 这种必须要求前面有空白分隔，否则会把 `Q3报告3天` 这类正常标题误伤。
   */
  const TIME_SUFFIXES = [
    /\s*\d+\s*(秒|分钟|分|小时|天|周|个月|月|年)\s*前\s*$/u,
    /\s*\d+\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?|mo|months?|y|years?)\s+ago\s*$/iu,
    /\s+(?:刚刚|刚才|just\s+now)$/iu,
    /\s+\d+\s*(?:秒|分钟|分|小时|天|周|个月|月|年)$/u,
    /\s+\d+\s*(?:s|min|mins|h|hr|hrs|d|day|days|w|mo|mos|y|yr|yrs)$/iu,
  ];

  /** 折叠空白并去首尾空格。 */
  function collapse(text) {
    return String(text ?? "").replace(/\s+/g, " ").trim();
  }

  /**
   * 去掉尾部的相对时间。
   *
   * 这一步不能省：在拿不到会话 id 的兜底路径上，标题会被当作会话的唯一标识，
   * 而相对时间每次采集都在变——不去掉就会导致"每个轮询周期都变成一个新会话"，从而永远不发通知。
   */
  function stripTrailingTime(text) {
    let out = collapse(text);
    for (const pattern of TIME_SUFFIXES) out = out.replace(pattern, "").trim();
    return out;
  }

  /** 会话标题：折叠空白 → 去尾部时间 → 截断。 */
  function cleanTitle(text, limit = 80) {
    const out = stripTrailingTime(text);
    if (out.length === 0) return "";
    return out.length > limit ? `${out.slice(0, limit)}…` : out;
  }

  globalThis.DshDomUtils = { collapse, stripTrailingTime, cleanTitle };
})();
