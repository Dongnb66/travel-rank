// env.js —— 环境变量引导模块
//
// 为什么必须有这个文件：本仓库此前**完全没有加载 .env 的代码**，却带了
// `backend/.env.example`，README 也写着「有 TRAVEL_LLM_KEY 走 DeepSeek」。
// 结果是：用户照着 .env.example 配好 Key，程序一个都读不到 ——
// AI 助手永远停在规则兜底，腾讯云短信永远停在演示模式，且没有任何提示。
//
// 另外，ESM 的 import 会被提升到模块体之前执行，所以「在 server.js 里
// 调 config()」这种写法也救不了：src/llm.js / src/agent.js 在模块加载阶段
// 就把 Key 快照成空串了。因此本模块必须作为 server.js 的**第一个 import**，
// 且各模块的 Key 读取一律改成「调用时取值」（见 src/agent.js / src/llm.js）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ENV_FILE =
  process.env.TRAVEL_ENV_FILE || path.join(__dirname, '..', '.env');

/** 解析 .env 文本 → 键值对（不做写入，便于单测） */
export function parseEnvFile(text) {
  return dotenv.parse(String(text || ''));
}

/**
 * 把 .env 加载进 process.env。已存在的键默认不覆盖（与 dotenv / node --env-file 一致），
 * 这样部署时用 shell 环境变量就能覆盖 .env，测试也不会被开发者的 .env 干扰。
 * @returns {string[]} 实际写入的键名
 */
export function loadEnvFile(filePath = DEFAULT_ENV_FILE, { override = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const parsed = parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  const applied = [];
  for (const [key, val] of Object.entries(parsed)) {
    if (override || !(key in process.env)) {
      process.env[key] = val;
      applied.push(key);
    }
  }
  return applied;
}

/** 占位符（.env.example 直接复制没改）不应被当成有效配置 */
export function isPlaceholder(v) {
  return /请填写|your[_-]?key|change[_-]?me|please[_-]?change|x{6,}/i.test(String(v || ''));
}

// 副作用：被导入即加载（server.js 的第一个 import）
loadEnvFile();
