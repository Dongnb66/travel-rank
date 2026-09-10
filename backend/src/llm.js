// llm.js —— 大模型摘要封装（有 key 走大模型，无 key 走规则兜底，绝不凭空编造）
import { buildRuleSummary } from './aggregator.js';
import { isPlaceholder } from './env.js';

// 配置在调用时读取（不在模块顶层快照），避免 ESM import 提升导致的时序 bug
function getLlmConfig() {
  const rawKey = process.env.TRAVEL_LLM_KEY || '';
  return {
    apiKey: isPlaceholder(rawKey) ? '' : rawKey,
    baseUrl: process.env.TRAVEL_LLM_BASE || 'https://api.deepseek.com/v1',
    model: process.env.TRAVEL_LLM_MODEL || 'deepseek-chat',
  };
}

/** 是否已配置可用的模型 Key（占位符视为未配置） */
export function llmConfigured() {
  return Boolean(getLlmConfig().apiKey);
}

// 用大模型把某地点的多篇帖子优点，凝练成一段自然语言的「平台总结」
export async function summarizeLocationLLM(locationId, context) {
  const { apiKey, baseUrl, model } = getLlmConfig();
  if (!apiKey) return { ok: true, source: 'rule', text: buildRuleSummary(locationId) };

  const prompt =
    `你是旅游平台的「口碑总结官」。下面是用户对「${context.locationName}」的若干篇真实分享帖，` +
    `请基于这些真实内容，凝练成 2-3 句话的地点总结，只提帖子里出现过的优点，不要编造：\n\n` +
    context.posts.map((p, i) => `帖${i + 1}：${p.title} —— ${p.content}`).join('\n');

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是严谨的旅游口碑总结助手，只基于给定素材总结，不虚构。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('LLM 返回为空');
    return { ok: true, source: 'llm', text };
  } catch (e) {
    // 任何失败都回退到规则版，保证可用性（防幻觉：不暴露错误也不编造）
    return { ok: true, source: 'rule-fallback', text: buildRuleSummary(locationId) };
  }
}
