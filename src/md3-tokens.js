/**
 * Material Design 3（Material You）色彩引擎。
 *
 * Material You 的核心不是"换几个颜色"，而是**色调板（tonal palette）**：
 * 一个种子色被展开成若干条固定色相、固定彩度、明度按 CIE L* 取值的色带（tone 0–100），
 * 界面上的每个角色（primary / surface / outline …）都固定引用某条色带的某个 tone。
 * 这样深浅色主题只是换一组 tone 映射，观感自动保持一致。
 *
 * 实现说明：MD3 官方的 tone 就是 CIE L*，色带生成用 Lab/LCh 即可。
 * 与官方 material-color-utilities 的差别是彩度采用 Lab 色度而非 CAM16 色度（近似）——
 * 色相与明度一致，彩度会有轻微差异。
 *
 * 本模块是纯函数，不碰 DOM；页面通过 applyScheme() 把结果写成 CSS 变量。
 */

/** MD3 基线种子色（Material You 默认的紫）。 */
export const DEFAULT_SEED = "#6750a4";

/** 几个常用种子色，供设置页一键切换。 */
export const SEED_PRESETS = [
  { name: "基线紫", hex: "#6750a4" },
  { name: "青碧", hex: "#00696d" },
  { name: "靛蓝", hex: "#2563eb" },
  { name: "苔绿", hex: "#3f6831" },
  { name: "陶土", hex: "#984715" },
  { name: "樱粉", hex: "#8e4585" },
];

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** #RRGGBB / #RGB → [r, g, b]（0–255）。 */
export function hexToRgb(hex) {
  const text = String(hex ?? "").trim().replace(/^#/, "");
  const full = text.length === 3 ? text.split("").map((c) => c + c).join("") : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

/** [r, g, b] → #rrggbb。 */
export function rgbToHex(rgb) {
  return `#${rgb.map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

//#region sRGB ↔ CIE Lab(D65)
function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function rgbToXyz(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  return [
    0.4123908 * r + 0.3575843 * g + 0.1804808 * b,
    0.212639 * r + 0.7151687 * g + 0.0721923 * b,
    0.0193308 * r + 0.1191948 * g + 0.9505322 * b,
  ];
}

function xyzToRgb(xyz) {
  const [x, y, z] = xyz;
  return [
    3.2409699 * x - 1.5373832 * y - 0.4986108 * z,
    -0.9692436 * x + 1.8759675 * y + 0.0415551 * z,
    0.0556301 * x - 0.203977 * y + 1.0569715 * z,
  ];
}

const WHITE_D65 = [0.9504559, 1, 1.0890578];

function xyzToLab(xyz) {
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [xyz[0] / WHITE_D65[0], xyz[1] / WHITE_D65[1], xyz[2] / WHITE_D65[2]].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToXyz([l, a, b]) {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const finv = (t) => {
    const t3 = t ** 3;
    return t3 > 216 / 24389 ? t3 : (108 / 841) * (t - 4 / 29);
  };
  return [finv(fx) * WHITE_D65[0], finv(fy) * WHITE_D65[1], finv(fz) * WHITE_D65[2]];
}
//#endregion

/** 提取种子色的 L*、彩度与色相（CIE LCh）。 */
export function seedLch(hex) {
  const [l, a, b] = xyzToLab(rgbToXyz(hexToRgb(hex)));
  const chroma = Math.hypot(a, b);
  let hue = (Math.atan2(b, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { lightness: l, chroma, hue };
}

function inGamut(linear) {
  return linear.every((value) => value >= -0.0005 && value <= 1.0005);
}

/** LCh → sRGB；超出色域时二分降低彩度，保证结果始终是合法颜色。 */
function lchToRgb(lightness, chroma, hue) {
  const radians = (hue * Math.PI) / 180;
  const attempt = (c) => xyzToRgb(labToXyz([clamp(lightness, 0, 100), c * Math.cos(radians), c * Math.sin(radians)]));

  let usable = 0;
  if (inGamut(attempt(chroma))) {
    usable = chroma;
  } else {
    let low = 0;
    let high = chroma;
    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2;
      if (inGamut(attempt(mid))) low = mid;
      else high = mid;
    }
    usable = low;
  }
  const linear = attempt(usable);
  return rgbToHex(linear.map((value) => clamp(linearToSrgb(clamp(value, 0, 1)), 0, 1) * 255));
}

/**
 * 生成一条色调板。
 * @param hue - 固定色相（度）。
 * @param chroma - 固定彩度；实际取值会按色域上限自动收敛。
 * @returns tone（0–100）→ #rrggbb 的函数。
 */
export function tonalPalette(hue, chroma) {
  return (tone) => lchToRgb(tone, chroma, hue);
}

/** MD3 各角色 → [色带, tone] 的映射（Tonal Spot 方案，即默认动态配色）。 */
const LIGHT_ROLES = {
  primary: ["primary", 40],
  "on-primary": ["primary", 100],
  "primary-container": ["primary", 90],
  "on-primary-container": ["primary", 10],
  secondary: ["secondary", 40],
  "on-secondary": ["secondary", 100],
  "secondary-container": ["secondary", 90],
  "on-secondary-container": ["secondary", 10],
  tertiary: ["tertiary", 40],
  "on-tertiary": ["tertiary", 100],
  "tertiary-container": ["tertiary", 90],
  "on-tertiary-container": ["tertiary", 10],
  error: ["error", 40],
  "on-error": ["error", 100],
  "error-container": ["error", 90],
  "on-error-container": ["error", 10],
  surface: ["neutral", 98],
  "surface-dim": ["neutral", 87],
  "surface-bright": ["neutral", 98],
  "surface-container-lowest": ["neutral", 100],
  "surface-container-low": ["neutral", 96],
  "surface-container": ["neutral", 94],
  "surface-container-high": ["neutral", 92],
  "surface-container-highest": ["neutral", 90],
  "on-surface": ["neutral", 10],
  "on-surface-variant": ["neutral-variant", 30],
  outline: ["neutral-variant", 50],
  "outline-variant": ["neutral-variant", 80],
  "inverse-surface": ["neutral", 20],
  "inverse-on-surface": ["neutral", 95],
  "inverse-primary": ["primary", 80],
  shadow: ["neutral", 0],
  scrim: ["neutral", 0],
  "surface-tint": ["primary", 40],
};

const DARK_ROLES = {
  primary: ["primary", 80],
  "on-primary": ["primary", 20],
  "primary-container": ["primary", 30],
  "on-primary-container": ["primary", 90],
  secondary: ["secondary", 80],
  "on-secondary": ["secondary", 20],
  "secondary-container": ["secondary", 30],
  "on-secondary-container": ["secondary", 90],
  tertiary: ["tertiary", 80],
  "on-tertiary": ["tertiary", 20],
  "tertiary-container": ["tertiary", 30],
  "on-tertiary-container": ["tertiary", 90],
  error: ["error", 80],
  "on-error": ["error", 20],
  "error-container": ["error", 30],
  "on-error-container": ["error", 90],
  surface: ["neutral", 6],
  "surface-dim": ["neutral", 6],
  "surface-bright": ["neutral", 24],
  "surface-container-lowest": ["neutral", 4],
  "surface-container-low": ["neutral", 10],
  "surface-container": ["neutral", 12],
  "surface-container-high": ["neutral", 17],
  "surface-container-highest": ["neutral", 22],
  "on-surface": ["neutral", 90],
  "on-surface-variant": ["neutral-variant", 80],
  outline: ["neutral-variant", 60],
  "outline-variant": ["neutral-variant", 30],
  "inverse-surface": ["neutral", 90],
  "inverse-on-surface": ["neutral", 20],
  "inverse-primary": ["primary", 40],
  shadow: ["neutral", 0],
  scrim: ["neutral", 0],
  "surface-tint": ["primary", 80],
};

/**
 * 由种子色推导出一整套 MD3 配色。
 *
 * 系数是拿 Lab 空间实测官方的基线配色校准过的——MD3 规范里的那组参数（色带彩度下限 48/16/24、
 * tertiary 偏移 +60、error 固定 hue 25 / chroma 84）定义在 CAM16 空间，直接套到 Lab 上会让
 * secondary / tertiary 偏艳、error 偏品红。校准后基线的每个角色都与官方值相差一两个色阶：
 *   官方 secondary #625B71 → Lab(303.6, 13.8)，官方 tertiary #7D5260 → Lab(357.9, 20.1)
 *   官方 error #B3261E → Lab(36.4, 68.2)
 *
 * 附带说明：即使种子几乎没有彩度，primary 仍会得到有彩度的颜色——这是 Material You 的既定行为，
 * 不是缺陷（官方实现在这一点上也是如此）。
 * @param seedHex - 种子色。
 * @param dark - true 生成深色方案。
 * @returns 角色名 → #rrggbb。
 */
export function scheme(seedHex, dark) {
  const { hue, chroma } = seedLch(seedHex);
  const bands = {
    primary: tonalPalette(hue, Math.max(48, chroma)),
    secondary: tonalPalette(hue, Math.max(13, chroma * 0.27)),
    tertiary: tonalPalette(hue + 53, Math.max(19, chroma * 0.39)),
    neutral: tonalPalette(hue, 4),
    "neutral-variant": tonalPalette(hue, 8),
    error: tonalPalette(36.4, 68.2),
  };
  const roles = dark === true ? DARK_ROLES : LIGHT_ROLES;
  const result = {};
  for (const [role, [band, tone]] of Object.entries(roles)) result[role] = bands[band](tone);
  return result;
}

/** 角色配色 → CSS 变量对象（`--md-sys-color-*`）。 */
export function schemeToCssVars(schemeMap, prefix = "--md-sys-color-") {
  const output = {};
  for (const [role, value] of Object.entries(schemeMap)) output[`${prefix}${role}`] = value;
  return output;
}

/** 相对亮度（WCAG）。 */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度，用于测试与无障碍自检。 */
export function contrast(hexA, hexB) {
  const [a, b] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/**
 * 决定实际生效的明暗。
 * @param preference - "auto" | "light" | "dark"。
 * @param prefersDark - 系统是否偏好深色。
 */
export function resolveMode(preference, prefersDark) {
  if (preference === "light" || preference === "dark") return preference;
  return prefersDark === true ? "dark" : "light";
}

/** 生成一份"默认种子"的静态配色 CSS，作为 JS 执行前的兜底（避免首帧闪白/闪紫）。 */
export function paletteCss(seedHex = DEFAULT_SEED) {
  const render = (map) => Object.entries(schemeToCssVars(map)).map(([name, value]) => `  ${name}: ${value};`).join("\n");
  const light = render(scheme(seedHex, false));
  const dark = render(scheme(seedHex, true));
  return [
    "/* 由 tools/gen-theme-css.mjs 生成，请勿手改；npm run theme 重新生成。 */",
    `:root, :root[data-theme="light"] {`,
    light,
    "}",
    "",
    "/* 跟随系统：未显式指定主题时使用深色方案 */",
    "@media (prefers-color-scheme: dark) {",
    "  :root:not([data-theme=\"light\"]) {",
    dark
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "  }",
    "}",
    "",
    ':root[data-theme="dark"] {',
    dark,
    "}",
    "",
  ].join("\n");
}
