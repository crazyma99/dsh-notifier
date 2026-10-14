/**
 * MD3 交互基元：水波纹与 Snackbar。
 *
 * 水波纹是 Material 里"按压反馈"的主要表达；Snackbar 用来做轻量结果提示，
 * 比在页面上堆一行行状态文字更接近 MD3 的做法。
 */

const RIPPLE_TARGETS = ".md-button, .md-list-item--interactive, .md-segmented label, .md-chip";

/**
 * 给容器内的 MD3 组件挂上水波纹（事件委托，动态元素无需重新绑定）。
 * @param root - 委托根节点，默认 document。
 * @returns 卸载函数。
 */
export function attachRipples(root = document) {
  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target.closest(RIPPLE_TARGETS) : null;
    if (target === null || target.hasAttribute("disabled")) return;

    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const size = Math.max(rect.width, rect.height) * 2;
    const ripple = document.createElement("span");
    ripple.className = "md-ripple";
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
    target.appendChild(ripple);

    const remove = () => ripple.remove();
    ripple.addEventListener("animationend", remove, { once: true });
    // 动画被"减少动效"策略压成 1ms 时的兜底，避免残留节点
    setTimeout(remove, 1000);
  };

  root.addEventListener("pointerdown", onPointerDown);
  return () => root.removeEventListener("pointerdown", onPointerDown);
}

/** 创建（或复用）一个 Snackbar。 */
export function createSnackbar() {
  let node = null;
  let timer = null;

  const ensure = () => {
    if (node !== null && node.isConnected) return node;
    node = document.createElement("div");
    node.className = "md-snackbar";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.appendChild(node);
    return node;
  };

  return {
    /**
     * 显示一条消息。
     * @param text - 消息内容。
     * @param options - durationMs 自动关闭时间；actionLabel/onAction 可选操作按钮。
     */
    show(text, options = {}) {
      const { durationMs = 4000, actionLabel, onAction } = options;
      const element = ensure();
      element.textContent = "";
      const label = document.createElement("span");
      label.textContent = String(text ?? "");
      element.appendChild(label);

      if (typeof actionLabel === "string" && typeof onAction === "function") {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "md-button md-button--text";
        action.style.color = "var(--md-sys-color-inverse-primary)";
        action.textContent = actionLabel;
        action.addEventListener("click", () => {
          onAction();
          this.hide();
        });
        element.appendChild(action);
      }

      // 先移除再添加，保证重复调用时过渡动画会重新播放
      element.dataset.open = "false";
      requestAnimationFrame(() => {
        element.dataset.open = "true";
      });

      if (timer !== null) clearTimeout(timer);
      if (durationMs > 0) timer = setTimeout(() => this.hide(), durationMs);
      return element;
    },

    hide() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (node !== null) node.dataset.open = "false";
    },
  };
}

/** 生成一个内联 Material 图标 SVG（MD3 用 24dp 网格、currentColor 填充）。 */
export function icon(pathData, { size = 24, className = "md-icon" } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}
