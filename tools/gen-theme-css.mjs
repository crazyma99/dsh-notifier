/**
 * 生成 src/md3-palette.css —— 默认种子色的静态配色。
 *
 * 为什么需要它：页面上的主题是 JS 算出来再写进 CSS 变量的，
 * 而模块脚本是延迟执行的；没有这份静态兜底，首帧会闪一下未上色的界面。
 * 用法：npm run theme
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SEED, paletteCss } from "../src/md3-tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "src", "md3-palette.css");

writeFileSync(target, paletteCss(DEFAULT_SEED), "utf8");
console.log(`已生成 ${target}（种子色 ${DEFAULT_SEED}）`);
