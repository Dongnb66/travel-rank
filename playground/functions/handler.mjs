// handler.mjs —— 途见·公网演示版业务 handler。
// 聚合权重/规划/ReAct 规则与本地完整版逐字同源；登录/私信/短信等本地能力不在公网版。
// 数据源：托管库迁移被平台拒绝（诊断缺失），公网版用 bundled 种子数据（seed.mjs）；
// 交互走 preview 无状态重算，不写库。演示身份仅浏览器本地。
import { SEED } from './seed.mjs';

const MAX_BODY = 100_000;
const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fail = (msg) => json(400, { ok: false, error: msg });

function str(v, name, max = 200) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} 必填`);
  const s = v.trim();
  if (s.length > max) throw new Error(`${name} 超长（上限 ${max}）`);
  return s;
}
function int(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
  return n;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uid(v, name) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error(`${name} 格式不合法`);
  return v;
}
async function body(req) {
  const t = await req.text();
  if (t.length > MAX_BODY) throw new Error('请求体过大');
  const v = t ? JSON.parse(t) : {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('请求体必须是对象');
  return v;
}
function need(r) {
  if (r.error) throw new Error('database_unavailable');
  return r.data;
}

/* ---- 数据读取（有界） ---- */
async function loadAll(sb) {
  if (!sb) return structuredClone(SEED);
  const [locs, posts, votes, advs, quotes] = await Promise.all([
    sb.from('locations').select('id,name,city,category,pinned').order('id').limit(100),
    sb.from('posts').select('id,location_id,author,avatar,title,content,price_per_day,rating,created_at').order('id').limit(1000),
    sb.from('post_votes').select('post_id,voter,value').limit(5000),
    sb.from('post_advantages').select('post_id,advantage').limit(5000),
    sb.from('price_quotes').select('location_id,provider,price,duration_days').order('price').limit(500),
  ]);
  return { locs: need(locs), posts: need(posts), votes: need(votes), advs: need(advs), quotes: need(quotes) };
}

/* ---- 聚合引擎（与本地 aggregator.js 同权重） ---- */
function votesOf(votes, pid) { return votes.filter((v) => v.post_id === pid).reduce((s, v) => s + v.value, 0); }
function locationHeat(posts, votes, lid) {
  const lp = posts.filter((p) => p.location_id === lid);
  const voteSum = lp.reduce((s, p) => s + votesOf(votes, p.id), 0);
  const rated = lp.filter((p) => p.rating != null);
  const avg = rated.length ? rated.reduce((s, p) => s + p.rating, 0) / rated.length : 0;
  return lp.length * 2 + voteSum * 3 + avg * 5;
}
function advantagesOf(advs, posts, lid, topN = 6) {
  const ids = new Set(posts.filter((p) => p.location_id === lid).map((p) => p.id));
  const freq = new Map();
  for (const a of advs) if (ids.has(a.post_id)) freq.set(a.advantage, (freq.get(a.advantage) || 0) + 1);
  return [...freq.entries()].map(([name, freq]) => ({ name, freq })).sort((a, b) => b.freq - a.freq || a.name.localeCompare(b.name)).slice(0, topN);
}
function hotPosts(posts, votes, advs, limit, lid = null) {
  return posts
    .filter((p) => lid == null || p.location_id === lid)
    .map((p) => ({ ...p, votes: votesOf(votes, p.id), advantages: advs.filter((a) => a.post_id === p.id).map((a) => a.advantage) }))
    .sort((a, b) => b.votes - a.votes || String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}
function leaderboard(d) {
  const board = d.locs.map((l) => ({
    ...l,
    heat: Math.round(locationHeat(d.posts, d.votes, l.id) * 10) / 10,
    postCount: d.posts.filter((p) => p.location_id === l.id).length,
    topAdvantages: advantagesOf(d.advs, d.posts, l.id),
    hotPosts: hotPosts(d.posts, d.votes, d.advs, 3, l.id),
  }));
  board.sort((a, b) => (b.pinned - a.pinned) || (b.heat - a.heat));
  return board;
}
function ruleSummary(d, lid) {
  const loc = d.locs.find((l) => l.id === lid);
  if (!loc) return null;
  const lp = d.posts.filter((p) => p.location_id === lid);
  if (!lp.length) return `${loc.name} 暂无用户分享，快来做第一个推荐人吧！`;
  const advText = advantagesOf(d.advs, d.posts, lid, 5).map((a) => a.name).join('、');
  const voteSum = lp.reduce((s, p) => s + votesOf(d.votes, p.id), 0);
  return `${loc.name} 被 ${lp.length} 篇帖子推荐、累计 ${voteSum} 个赞，高频优点：${advText}。`;
}

/* ---- 规划（与本地 planner.js 同逻辑） ---- */
function planTrip(d, input) {
  const dests = Array.isArray(input?.destinations) ? input.destinations : [];
  if (!dests.length) return { ok: false, error: '请至少选择一个目的地' };
  const budget = Number(input.budget) || null;
  const stops = [];
  let totalCost = 0;
  for (const dest of dests) {
    const loc = d.locs.find((l) => l.id === String(dest.locationId));
    if (!loc) continue;
    const days = Math.max(1, Number(dest.days) || 3);
    const qs = d.quotes.filter((q) => q.location_id === loc.id);
    const quote = qs.find((q) => q.duration_days === days) || qs[0] || null;
    const cost = quote ? Math.round(quote.price * (days / quote.duration_days)) : null;
    if (cost) totalCost += cost;
    const rated = d.posts.filter((p) => p.location_id === loc.id && p.rating != null);
    stops.push({ locationId: loc.id, name: loc.name, city: loc.city, category: loc.category, days, chosenProvider: quote?.provider ?? null, chosenPrice: quote?.price ?? null, estCost: cost, comparison: qs, avgRating: rated.length ? rated.reduce((s, p) => s + p.rating, 0) / rated.length : 3 });
  }
  stops.sort((a, b) => a.city !== b.city ? (a.city < b.city ? -1 : 1) : (b.avgRating / (b.chosenPrice || 9999)) - (a.avgRating / (a.chosenPrice || 9999)));
  const recommendation = budget == null
    ? `已为你规划 ${stops.length} 站路线，预计总花费约 ¥${totalCost}。`
    : totalCost <= budget
      ? `预算 ¥${budget} 充足，本路线预计 ¥${totalCost}，还可酌情升级住宿或增加天数。`
      : `预算 ¥${budget} 不足，超出约 ¥${totalCost - budget}。建议：缩短天数、改选更低价套餐，或删减 1 站非核心目的地。`;
  return { ok: true, route: stops.map((s) => s.name), stops, totalCost, budget, recommendation };
}

/* ---- LLM（有 Key 走模型，无 Key/失败回退规则，不编造） ---- */
function llmConfig(env) {
  const key = env('TRAVEL_LLM_KEY') || '';
  const placeholder = !key || /your|placeholder|example|xxx|test/i.test(key);
  return { apiKey: placeholder ? '' : key, baseUrl: env('TRAVEL_LLM_BASE') || 'https://api.deepseek.com/v1', model: env('TRAVEL_LLM_MODEL') || 'deepseek-chat' };
}
async function llmText(cfg, system, user) {
  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.3 }),
  });
  if (!resp.ok) throw new Error('LLM HTTP ' + resp.status);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM 返回为空');
  return text;
}

/* ---- ReAct 助手（工具调用循环，4 轮上限，与本地 agent.js 同构） ---- */
function toolDispatch(d) {
  return {
    list_locations: () => d.locs.map((l) => `${l.name}（${l.city}·${l.category}）`).join('、'),
    get_price: (a) => {
      const loc = d.locs.find((l) => l.name.includes(String(a.locationName || '')));
      if (!loc) return `未收录「${a.locationName}」`;
      const qs = d.quotes.filter((q) => q.location_id === loc.id);
      return qs.map((q) => `${q.provider} ¥${q.price}/${q.duration_days}天`).join('、') || '暂无报价';
    },
    optimize_route: (a) => {
      const names = Array.isArray(a.destNames) ? a.destNames : [];
      const dests = names.map((n) => d.locs.find((l) => l.name.includes(String(n).replace(/[市省]/g, '')) || String(n).includes(l.name))).filter(Boolean).map((l) => ({ locationId: l.id, days: a.daysEach || 3 }));
      if (!dests.length) return '没识别到已知目的地，先告诉我你想去哪几个城市吧~';
      const r = planTrip(d, { destinations: dests, budget: a.budget });
      return r.ok ? `推荐路线：${r.route.join(' → ')}；预计总花费约 ¥${r.totalCost}。${r.recommendation}` : r.error;
    },
    baidu_map_search: (a) => {
      const mock = { 美食: ['巷子里的老字号面馆', '本地人私藏夜市', '社区便民小吃街'], 拍照: ['人少景美的城市天台', '老城区文艺巷弄', '傍晚的江边步道'], 小众: ['冷门博物馆', '本地人才知道的观景台', '城郊秘境湿地公园'] };
      const kw = String(a.keyword || '');
      const key = Object.keys(mock).find((k) => kw.includes(k)) || '小众';
      return `（地图演示数据）「${a.city || '当地'}」的宝藏${kw}：${mock[key].join('、')}`;
    },
  };
}
const TOOLS = [
  { type: 'function', function: { name: 'list_locations', description: '列出平台已收录的旅游地点', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_price', description: '查询某地点的套餐/方式报价', parameters: { type: 'object', properties: { locationName: { type: 'string' } }, required: ['locationName'] } } },
  { type: 'function', function: { name: 'optimize_route', description: '根据目的地列表做路线规划与比价', parameters: { type: 'object', properties: { destNames: { type: 'array', items: { type: 'string' } }, daysEach: { type: 'number' }, budget: { type: 'number' } } } } },
  { type: 'function', function: { name: 'baidu_map_search', description: '搜索某城市的宝藏地点（美食/拍照/小众，演示数据）', parameters: { type: 'object', properties: { keyword: { type: 'string' }, city: { type: 'string' } } } } },
];
function ruleChat(d, messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = String(last?.content || '').toLowerCase();
  const disp = toolDispatch(d);
  if (/路线|规划|去|行程/.test(text)) {
    const names = d.locs.map((l) => l.name).filter((n) => text.includes(n));
    return disp.optimize_route({ destNames: names.length ? names : d.locs.slice(0, 3).map((l) => l.name) });
  }
  if (/宝藏|小众|美食|拍照/.test(text)) {
    const city = d.locs.find((l) => text.includes(l.city))?.city || '当地';
    return '（规则助手）' + disp.baidu_map_search({ keyword: text.includes('美食') ? '美食' : text.includes('拍照') ? '拍照' : '小众', city });
  }
  if (/价格|报价|多少钱/.test(text)) {
    const loc = d.locs.find((l) => text.includes(l.name));
    return loc ? `「${loc.name}」报价：${disp.get_price({ locationName: loc.name })}` : `可查地点：${disp.list_locations()}`;
  }
  return '我是途见旅行助手~ 可以帮你：①规划路线（如"帮我规划三亚+成都5日游"）②比价 ③挖宝藏地点（如"成都小众美食"）。当前为离线规则模式，配置模型 Key 后走工具调用智能体。';
}
async function chatWithAgent(d, cfg, messages) {
  if (!cfg.apiKey) return { source: 'rule', content: ruleChat(d, messages) };
  try {
    const disp = toolDispatch(d);
    const conv = messages.map((m) => ({ role: m.role, content: String(m.content) }));
    for (let round = 0; round < 4; round++) {
      const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: '你是「途见」旅游助手，擅长路线规划、比价、挖掘宝藏地点。优先调用工具获取真实数据后回答，不编造。' }, ...conv], tools: TOOLS, tool_choice: 'auto' }),
      });
      if (!resp.ok) throw new Error('LLM HTTP ' + resp.status);
      const msg = (await resp.json()).choices?.[0]?.message;
      if (!msg?.tool_calls) return { source: 'llm', content: msg?.content || '（无回复）' };
      conv.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const fn = disp[tc.function.name];
        const args = JSON.parse(tc.function.arguments || '{}');
        conv.push({ role: 'tool', tool_call_id: tc.id, content: String(fn ? await fn(args) : '未知工具') });
      }
    }
    return { source: 'llm', content: '（规划较复杂，已为你分步处理，请告诉我更多偏好）' };
  } catch {
    return { source: 'rule-fallback', content: ruleChat(d, messages) };
  }
}

export async function handleTravel({ request, supabase, env }) {
  const tool = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    if (request.method === 'GET') {
      if (tool === 'health') return json(200, { ok: true, version: 'playground-1.0.0', time: new Date().toISOString() });
      const d = await loadAll(supabase);
      if (tool === 'locations') return json(200, { ok: true, locations: d.locs });
      if (tool === 'leaderboard') return json(200, { ok: true, board: leaderboard(d) });
      if (tool === 'hot') return json(200, { ok: true, posts: hotPosts(d.posts, d.votes, d.advs, 10) });
      if (tool === 'posts') {
        const lid = new URL(request.url).searchParams.get('locationId');
        return json(200, { ok: true, posts: hotPosts(d.posts, d.votes, d.advs, 50, lid ? uid(lid, 'locationId') : null) });
      }
      if (tool === 'price') {
        const lid = uid(new URL(request.url).searchParams.get('locationId'), 'locationId');
        return json(200, { ok: true, quotes: d.quotes.filter((q) => q.location_id === lid) });
      }
      if (tool === 'comments') {
        const pid = uid(new URL(request.url).searchParams.get('postId'), 'postId');
        if (!supabase) return json(200, { ok: true, comments: SEED.comments.filter((c) => c.post_id === pid) });
        const r = await supabase.from('comments').select('id,author,content,created_at').eq('post_id', pid).order('id').limit(100);
        return json(200, { ok: true, comments: need(r) });
      }
      if (['preview', 'summarize', 'plan', 'chat'].includes(tool)) return json(405, { ok: false, error: `${tool} 仅支持 POST` });
      return json(404, { ok: false, error: '未知路由' });
    }
    if (request.method !== 'POST') return json(405, { ok: false, error: '仅支持 GET/POST' });
    const b = await body(request);

    if (tool === 'preview') {
      // 无状态聚合演示：浏览器本地的演示帖/投票并入种子数据重算榜单，不写库。
      // 公网版不开放匿名持久写（平台身份契约：写需verified identity）；持久社区能力在本地完整版。
      const d = await loadAll(supabase);
      const extra = Array.isArray(b.extraPosts) ? b.extraPosts.slice(0, 20) : [];
      const posts = [...d.posts];
      const advs = [...d.advs];
      const votes = [...d.votes];
      extra.forEach((e, i) => {
        const lid = uid(e.locationId, 'locationId');
        if (!d.locs.some((l) => l.id === lid)) throw new Error('地点不存在');
        const pid = 'local-' + i;
        posts.push({ id: pid, location_id: lid, author: str(e.author || '演示游客', '署名', 20), avatar: '🧳', title: str(e.title, '标题', 60), content: str(e.content, '内容', 1000), price_per_day: null, rating: e.rating == null ? null : int(e.rating, '评分', 1, 5), created_at: new Date().toISOString() });
        for (const a of (Array.isArray(e.advantages) ? e.advantages.slice(0, 8) : [])) advs.push({ post_id: pid, advantage: str(a, '优点', 20) });
        const v = int(e.votes ?? 0, 'votes', 0, 1000);
        if (v) votes.push({ post_id: pid, voter: 'local', value: v });
      });
      const localVotes = b.localVotes && typeof b.localVotes === 'object' ? b.localVotes : {};
      for (const [pid, delta] of Object.entries(localVotes).slice(0, 200)) {
        const n = int(delta, 'localVotes', -1000, 1000);
        if (n) votes.push({ post_id: pid, voter: 'local-tap', value: n });
      }
      return json(200, { ok: true, board: leaderboard({ ...d, posts, advs, votes }) });
    }
    if (tool === 'summarize') {
      const lid = uid(b.locationId, 'locationId');
      const d = await loadAll(supabase);
      const loc = d.locs.find((l) => l.id === lid);
      if (!loc) return json(404, { ok: false, error: '地点不存在' });
      const cfg = llmConfig(env);
      if (!cfg.apiKey) return json(200, { ok: true, location: loc.name, summary: ruleSummary(d, lid), source: 'rule' });
      try {
        const posts = d.posts.filter((p) => p.location_id === lid);
        const text = await llmText(cfg, '你是严谨的旅游口碑总结助手，只基于给定素材总结，不虚构。', `你是旅游平台的「口碑总结官」。下面是用户对「${loc.name}」的若干篇真实分享帖，请基于这些真实内容凝练成 2-3 句话的地点总结，只提帖子里出现过的优点：\n\n${posts.map((p, i) => `帖${i + 1}：${p.title} —— ${p.content}`).join('\n')}`);
        return json(200, { ok: true, location: loc.name, summary: text, source: 'llm' });
      } catch {
        return json(200, { ok: true, location: loc.name, summary: ruleSummary(d, lid), source: 'rule-fallback' });
      }
    }
    if (tool === 'plan') {
      const d = await loadAll(supabase);
      const r = planTrip(d, b);
      return json(r.ok ? 200 : 400, r);
    }
    if (tool === 'chat') {
      const messages = Array.isArray(b.messages) ? b.messages.slice(-12) : [];
      if (!messages.length) return fail('消息为空');
      const d = await loadAll(supabase);
      const r = await chatWithAgent(d, llmConfig(env), messages);
      return json(200, { ok: true, reply: r.content, source: r.source });
    }
    return json(404, { ok: false, error: '未知路由' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg === 'database_unavailable' ? json(503, { ok: false, error: '数据库暂不可用' }) : fail(msg);
  }
}