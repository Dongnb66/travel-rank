// test_agent_react.mjs —— AI 旅行助手「自主决策」行为的离线验证
//
// 为什么需要它：agent.js 号称是 ReAct 式自主决策循环（tool_choice:auto +
// 多轮工具调用 + 自终止），但 test_smoke.mjs 只断言「接口返回了非空字符串」。
// 无 Key 时走的是 ruleChat 规则分支，**根本没碰过 tool_calls** —— 也就是说
// 「自主决策」这条口径此前没有任何测试能证明。
//
// 本文件用 fetch 桩模拟 OpenAI 兼容接口，把模型换成可控的脚本，
// 直接断言 agent 在多种模型行为下的表现是否真的满足「自主决策」的语义：
//   1. 无 Key → 走规则兜底，且一次网络都不发（离线可跑）
//   2. 模型要工具 → agent 真的执行工具，并把真实结果回灌给模型
//   3. 多轮工具调用 → 逐轮执行，直到模型不再要工具才收尾（自终止）
//   4. 模型一直要工具 → 第 4 轮强制收尾，不无限循环（防失控）
//   5. 接口报错 → 降级规则兜底，管线不中断
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

/** 取第 n 次请求里 role='tool' 的消息 */
function toolMessagesOf(call) {
  return (call?.body?.messages || []).filter((m) => m.role === 'tool');
}

/* ============ 1. 无 Key：规则兜底，零网络 ============ */
console.log('\n== 1. 无 Key → 规则兜底且不发起任何模型请求 ==');
delete process.env.TRAVEL_LLM_KEY;
calls = [];
responder = () => { throw new Error('不该发起请求'); };
const noKeyAgent = await import('./src/agent.js?mode=nokey');
const r1 = await noKeyAgent.chatWithAgent([{ role: 'user', content: '帮我规划三亚+成都的行程' }]);
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
const keyAgent = await import('./src/agent.js?mode=key');
const r2 = await keyAgent.chatWithAgent([{ role: 'user', content: '三亚多少钱' }]);
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
const r3 = await keyAgent.chatWithAgent([{ role: 'user', content: '帮我安排一下' }]);
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
const r4 = await keyAgent.chatWithAgent([{ role: 'user', content: '一直查' }]);
check('请求轮次被钉死在 4 轮（上限防失控）', calls.length === 4, `实际 ${calls.length}`);
check('达到上限时返回收尾话术而不是报错', r4.ok === true && r4.content.includes('分步处理'), `实际 ${r4.content}`);

/* ============ 5. 模型接口报错 → 降级规则兜底 ============ */
console.log('\n== 5. 模型接口报错 → 降级规则兜底，管线不中断 ==');
calls = [];
responder = () => ({ ok: false, status: 500, json: async () => ({}) });
const r5 = await keyAgent.chatWithAgent([{ role: 'user', content: '帮我规划三亚行程' }]);
check('降级为规则兜底（source=rule）', r5.source === 'rule', `实际 source=${r5.source}`);
check('仍返回可用回复', typeof r5.content === 'string' && r5.content.length > 0);
check('只尝试了 1 次模型请求就降级（不重试轰炸）', calls.length === 1, `实际 ${calls.length}`);

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
