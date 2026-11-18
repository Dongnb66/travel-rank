// 公网演示版构建：原样拷贝 playground/{web,functions} 到会话工作区（Sites projectRoot 边界）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
if (!out) throw new Error("用法: node scripts/build-playground.mjs <输出目录>");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(root, "playground", "web"), path.join(out, "web"));
copyDir(path.join(root, "playground", "functions"), path.join(out, "functions"));
console.log("travel-rank playground 已生成：" + out);