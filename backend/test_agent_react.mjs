// test_agent_react.mjs —— AI 旅行助手「自主决策」行为 + 环境变量加载的离线验证
//
// 为什么需要它：
//  1) agent.js 号称是 ReAct 式自主决策循环（tool_choice:auto + 多轮工具调用 +
//     自终止），但 test_smoke.mjs 只断言「接口返回了非空字符串」。无 Key 时走的是
//     ruleChat 规则分支，**根本没碰过 tool_calls** ——「自主决策」此前没有测试能证明。
//  2) 本仓库此前**完全没有加载 .env 的代码**，却带了 backend/.env.example，
//     README 也写着「有 TRAVEL_LLM_KEY 走 DeepSeek」。照着配 Key 一个都读不到，
//     AI 助手永远停在规则兜底。本文件把该 bug 固化成回归断言。
//
// 做法：用 fetch 桩模拟 OpenAI 兼容接口，把模型换成可控脚本，
// 让「模型要几轮工具 / 要哪个工具 / 何时收尾」变成可断言的事件。
//
// 运行：node --experimental-sqlite test_agent_react.mjs

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 用临时库，避免污染开发数据
const TMP_DB = path.join(os.tmpdir(), `travel-agent-test-${Date.now()}.db`);
process.env.TRAVEL_DB = TMP_DB;
process.env.TRAVEL_LLM_BASE = 'https://llm.test/v1';
process.env.TRAVEL_LLM_MODEL = 'test-model';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log('  [PASS]', name);
    pass++;
  } else {
    console.log('  [FAIL]', name, extra ? `-> ${extra}` : '');
    fail++;
  }
}

/* ============ fetch 桩 ============ */
let calls = [];      // 记录每次请求
let responder = null; // (roundIndex, body) => Response-like

globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body });
  if (!responder) throw new Error('未设置 responder');
  return responder(calls.length, body);
};

const okJson = (payload) => ({ ok: true, status: 200, json: async () => payload });
const toolCall = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const assistantWithTools = (tcs) => okJson({ choices: [{ message: { content: '', tool_calls: tcs } }] });
const assistantWithText = (text) => okJson({ choices: [{ message: { content: text } }] });

/** 取某次请求里 role='tool' 的消息 */
function toolMessagesOf(call) {
  return (call?.body?.messages || []).filter((m) => m.role === 'tool');
}

/* ============ 0. 环境变量加载（原 bug 的回归守卫） ============ */
console.log('\n== 0. 环境变量加载：Key 必须能被读到（原 bug 回归守卫） ==');

// 故意「先 import 再设 Key」，复刻原 bug 的时序
const env = await import('./src/env.js');
const agent = await import('./src/agent.js');
const llm = await import('./src/llm.js');

const parsed = env.parseEnvFile([
  '# 注释行会被忽略',
  'A=1',
  'B = hello world ',
  'C="带 空格"',
  "D='单引号'",
  'E=有值 # 行尾注释',
  'F=',
  'G=请填写你的_API_Key',
  '这一行没有等号',
].join('\n'));
check('忽略注释行与无等号行', parsed['# 注释行会被忽略'] === undefined && Object.keys(parsed).length === 7, `keys=${Object.keys(parsed)}`);
check('解析普通键值对', parsed.A === '1' && parsed.B === 'hello world', `A=${parsed.A} B=${parsed.B}`);
check('剥离双/单引号', parsed.C === '带 空格' && parsed.D === '单引号', `C=${parsed.C} D=${parsed.D}`);
check('剥离行尾注释', parsed.E === '有值', `E=${parsed.E}`);
check('空值解析为空串', parsed.F === '', `F=${JSON.stringify(parsed.F)}`);

// 临时 .env：断言真的被加载，且不覆盖已有环境变量
const TMP_ENV = path.join(os.tmpdir(), `travel-env-${Date.now()}.env`);
fs.writeFileSync(TMP_ENV, 'TRAVEL_TEST_NEW=from-file\nTRAVEL_TEST_KEEP=from-file\n', 'utf8');
process.env.TRAVEL_TEST_KEEP = 'from-shell';
const applied = env.loadEnvFile(TMP_ENV);
check('loadEnvFile 把 .env 写进 process.env', process.env.TRAVEL_TEST_NEW === 'from-file', `实际 ${process.env.TRAVEL_TEST_NEW}`);
check('loadEnvFile 不覆盖已有环境变量（部署时 shell 可覆盖）', process.env.TRAVEL_TEST_KEEP === 'from-shell', `实际 ${process.env.TRAVEL_TEST_KEEP}`);
check('loadEnvFile 返回生效键列表', applied.includes('TRAVEL_TEST_NEW') && !applied.includes('TRAVEL_TEST_KEEP'), `applied=${applied}`);
check('占位符（.env.example 直接复制）不算已配置', env.isPlaceholder('请填写你的_API_Key') === true && env.isPlaceholder('sk-real-key-123') === false);
fs.rmSync(TMP_ENV, { force: true });

delete process.env.TRAVEL_LLM_KEY;
check('无 Key → llmConfigured() = false', agent.llmConfigured() === false && llm.llmConfigured() === false);
process.env.TRAVEL_LLM_KEY = 'late-key-set-after-import';
check('import 之后再设 Key 也能读到（原 bug 就死在这里）', agent.llmConfigured() === true && llm.llmConfigured() === true);
process.env.TRAVEL_LLM_KEY = '请填写你的_API_Key';
check('占位符 Key → 视为未配置（走规则兜底而不是报 401）', agent.llmConfigured() === false);

/* ============ 1. 无 Key：规则兜底，零网络 ============ */
console.log('\n== 1. 无 Key → 规则兜底且不发起任何模型请求 ==');
delete process.env.TRAVEL_LLM_KEY;
calls = [];
responder = () => { throw new Error('不该发起请求'); };
const r1 = await agent.chatWithAgent([{ role: 'user', content: '帮我规划三亚+成都的行程' }]);
check('返回 source=rule（走了规则分支）', r1.source === 'rule', `实际 source=${r1.source}`);
check('返回了非空回复', typeof r1.content === 'string' && r1.content.length > 0);
check('全程 0 次模型请求（离线可跑）', calls.length === 0, `实际 ${calls.length} 次`);

/* ============ 2. 单轮工具调用 → 执行工具 → 回灌 → 收尾 ============ */
console.log('\n== 2. 模型要一次工具 → agent 执行工具并把真实结果回灌 ==');
process.env.TRAVEL_LLM_KEY = 'test-key';
calls = [];
responder = (round) => {
  if (round === 1) return assistantWithTools([toolCall('c1', 'get_price', { locationName: '三亚' })]);
  return assistantWithText('三亚的报价我看过了。');
};
const r2 = await agent.chatWithAgent([{ role: 'user', content: '三亚多少钱' }]);
check('第一轮请求带 tool_choice=auto（把决定权交给模型）', calls[0]?.body?.tool_choice === 'auto', `实际 ${calls[0]?.body?.tool_choice}`);
check('第一轮请求注册了 4 个工具', (calls[0]?.body?.tools || []).length === 4, `实际 ${(calls[0]?.body?.tools || []).length}`);
check('共发起 2 轮请求（工具轮 + 收尾轮）', calls.length === 2, `实际 ${calls.length}`);
const tmsgs = toolMessagesOf(calls[1]);
check('第二轮把工具执行结果以 role=tool 回灌给模型', tmsgs.length === 1, `实际 ${tmsgs.length} 条`);
check('回灌内容来自真实数据库（含 ¥ 报价）', typeof tmsgs[0]?.content === 'string' && tmsgs[0].content.includes('¥'), `实际: ${tmsgs[0]?.content}`);
check('tool_call_id 对齐（模型能对应上哪个调用）', tmsgs[0]?.tool_call_id === 'c1', `实际 ${tmsgs[0]?.tool_call_id}`);
check('模型不再要工具 → 自终止并返回文本', r2.source === 'llm' && r2.content === '三亚的报价我看过了。', `实际 source=${r2.source} content=${r2.content}`);

/* ============ 3. 多轮工具调用：逐轮执行 ============ */
console.log('\n== 3. 多轮工具调用 → 逐轮执行，模型说停才停 ==');
calls = [];
responder = (round) => {
  if (round === 1) return assistantWithTools([toolCall('a1', 'list_locations', {})]);
  if (round === 2) return assistantWithTools([toolCall('a2', 'optimize_route', { destNames: ['三亚', '成都'], daysEach: 3 })]);
  return assistantWithText('给你排好了。');
};
const r3 = await agent.chatWithAgent([{ role: 'user', content: '帮我安排一下' }]);
check('共 3 轮：两次工具 + 一次收尾', calls.length === 3, `实际 ${calls.length}`);
check('第 2 轮上下文含第 1 次的工具结果', toolMessagesOf(calls[1]).length === 1, `实际 ${toolMessagesOf(calls[1]).length}`);
check('第 3 轮上下文含前两轮的 2 条工具结果', toolMessagesOf(calls[2]).length === 2, `实际 ${toolMessagesOf(calls[2]).length}`);
check('路线规划工具真的调了 planner（结果含 推荐路线 或 总花费）',
  /推荐路线|预计总花费/.test(toolMessagesOf(calls[2]).map((m) => m.content).join(' ')));
check('最终返回模型收尾文本', r3.content === '给你排好了。', `实际 ${r3.content}`);

/* ============ 4. 一直要工具 → 第 4 轮强制收尾（防失控） ============ */
console.log('\n== 4. 模型每轮都要工具 → 4 轮上限强制收尾（防无限循环） ==');
calls = [];
responder = () => assistantWithTools([toolCall('loop', 'list_locations', {})]);
const r4 = await agent.chatWithAgent([{ role: 'user', content: '一直查' }]);
check('请求轮次被钉死在 4 轮（上限防失控）', calls.length === 4, `实际 ${calls.length}`);
check('达到上限时返回收尾话术而不是报错', r4.ok === true && r4.content.includes('分步处理'), `实际 ${r4.content}`);

/* ============ 5. 模型接口报错 → 降级规则兜底 ============ */
console.log('\n== 5. 模型接口报错 → 降级规则兜底，管线不中断 ==');
calls = [];
responder = () => ({ ok: false, status: 500, json: async () => ({}) });
const r5 = await agent.chatWithAgent([{ role: 'user', content: '帮我规划三亚行程' }]);
check('降级为规则兜底（source=rule）', r5.source === 'rule', `实际 source=${r5.source}`);
check('仍返回可用回复', typeof r5.content === 'string' && r5.content.length > 0);
check('只尝试了 1 次模型请求就降级（不重试轰炸）', calls.length === 1, `实际 ${calls.length}`);

/* ============ 6. 口碑总结（llm.js）同样吃 .env 的 Key ============ */
console.log('\n== 6. 口碑总结（llm.js）：有 Key 走模型，无 Key 走规则聚合 ==');
delete process.env.TRAVEL_LLM_KEY;
calls = [];
const s1 = await llm.summarizeLocationLLM(1, { locationName: '三亚', posts: [{ title: 't', content: 'c' }] });
check('无 Key → source=rule，且 0 次请求', s1.source === 'rule' && calls.length === 0, `source=${s1.source} calls=${calls.length}`);

process.env.TRAVEL_LLM_KEY = 'test-key';
calls = [];
responder = () => okJson({ choices: [{ message: { content: '三亚的海很干净，夜市热闹。' } }] });
const s2 = await llm.summarizeLocationLLM(1, { locationName: '三亚', posts: [{ title: '海干净', content: '水清沙细' }] });
check('有 Key → source=llm，且请求带 prompt 里的真实素材', s2.source === 'llm' && s2.text.includes('海很干净'), `source=${s2.source}`);
check('总结请求把素材原文放进 user 消息（不凭空生成）', (calls[0]?.body?.messages?.[1]?.content || '').includes('水清沙细'), '素材未进入 prompt');

calls = [];
responder = () => ({ ok: false, status: 429, json: async () => ({}) });
const s3 = await llm.summarizeLocationLLM(1, { locationName: '三亚', posts: [{ title: 't', content: 'c' }] });
check('模型报错 → 降级规则聚合（source=rule-fallback）', s3.source === 'rule-fallback' && s3.ok === true, `实际 ${JSON.stringify(s3)}`);

/* ============ 汇总 ============ */
console.log('\n' + '='.repeat(42));
console.log(`  测试总数: ${pass + fail}`);
console.log(`  通过    : ${pass}`);
console.log(`  失败    : ${fail}`);
console.log('='.repeat(42));

try {
  fs.rmSync(TMP_DB, { force: true });
  fs.rmSync(TMP_DB + '-wal', { force: true });
  fs.rmSync(TMP_DB + '-shm', { force: true });
} catch { /* ignore */ }

process.exit(fail === 0 ? 0 : 1);
