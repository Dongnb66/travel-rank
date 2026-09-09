// agent.js —— AI 旅行助手（智能体 + 工具调用）
// 能力：对话答疑、路线规划、价格比较、调用百度地图搜「宝藏地点」
// 有 DeepSeek Key 走 function calling；无 Key 走规则兜底，保证可运行、不编造
import { db, getPriceQuotes, getAllLocations } from './db.js';
import { planTrip } from './planner.js';

const API_KEY = process.env.TRAVEL_LLM_KEY || '';
const BASE_URL = process.env.TRAVEL_LLM_BASE || 'https://api.deepseek.com/v1';
const MODEL = process.env.TRAVEL_LLM_MODEL || 'deepseek-chat';

// 工具 1：列出平台已有地点
function listLocations() {
  return getAllLocations().map((l) => `${l.name}（${l.city}·${l.category}）`).join('、');
}
// 工具 2：查某地点套餐报价
function getPrice(locationName) {
  const loc = db.prepare('SELECT id,name FROM locations WHERE name LIKE ?').get(`%${locationName}%`);
  if (!loc) return `未收录「${locationName}」`;
  const qs = getPriceQuotes(loc.id);
  return qs.map((q) => `${q.provider} ¥${q.price}/${q.duration_days}天`).join('、') || '暂无报价';
}
// 工具 3：路线优化（接 planner 的真实规划逻辑）
function optimizeRoute(destNames, daysEach = 3, budget = null) {
  const all = getAllLocations();
  const dests = destNames
    .map((n) => all.find((l) => l.name.includes(n.replace(/[市省]/g, '')) || n.includes(l.name)))
    .filter(Boolean)
    .map((l) => ({ locationId: l.id, days: daysEach }));
  if (dests.length === 0) return '没识别到已知目的地，先告诉我你想去哪几个城市吧~';
  const r = planTrip({ destinations: dests, budget });
  return r.ok
    ? `推荐路线：${r.route.join(' → ')}；预计总花费约 ¥${r.totalCost}。${r.recommendation}`
    : r.error;
}
// 工具 4：百度地图搜「宝藏地点」（真实 API 或 mock 兜底）
async function baiduMapSearch(keyword, city) {
  const AK = process.env.BAIDU_MAP_AK;
  if (AK) {
    try {
      const url = `https://api.map.baidu.com/place/v2/search?query=${encodeURIComponent(keyword)}&region=${encodeURIComponent(city || '')}&scope=2&ak=${AK}&output=json`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.results) return d.results.slice(0, 5).map((x) => `${x.name}（${x.address || ''}）`).join('、');
    } catch { /* 落 mock */ }
  }
  const mock = {
    美食: ['巷子里的老字号面馆', '本地人私藏夜市', '社区便民小吃街'],
    拍照: ['人少景美的城市天台', '老城区文艺巷弄', '傍晚的江边步道'],
    小众: ['冷门博物馆', '本地人才知道的观景台', '城郊秘境湿地公园'],
  };
  const key = Object.keys(mock).find((k) => keyword.includes(k)) || '小众';
  return `（百度地图 mock）「${city || '当地'}」的宝藏${keyword}：${mock[key].join('、')}`;
}

const TOOLS = [
  { type: 'function', function: { name: 'list_locations', description: '列出平台已收录的旅游地点', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_price', description: '查询某地点的套餐/方式报价', parameters: { type: 'object', properties: { locationName: { type: 'string' } }, required: ['locationName'] } } },
  { type: 'function', function: { name: 'optimize_route', description: '根据目的地列表做路线规划与比价', parameters: { type: 'object', properties: { destNames: { type: 'array', items: { type: 'string' } }, daysEach: { type: 'number' }, budget: { type: 'number' } } } } },
  { type: 'function', function: { name: 'baidu_map_search', description: '调用百度地图搜索某城市的宝藏地点（美食/拍照/小众）', parameters: { type: 'object', properties: { keyword: { type: 'string' }, city: { type: 'string' } } } } },
];

const dispatch = { list_locations: () => listLocations(), get_price: (a) => getPrice(a.locationName), optimize_route: (a) => optimizeRoute(a.destNames || [], a.daysEach, a.budget), baidu_map_search: (a) => baiduMapSearch(a.keyword, a.city) };

// 主入口：messages = [{role, content}]
export async function chatWithAgent(messages) {
  if (!API_KEY) return ruleChat(messages);
  try {
    const tools = TOOLS;
    let conv = messages.map((m) => ({ role: m.role, content: m.content }));
    for (let round = 0; round < 4; round++) {
      const resp = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: '你是「途见」旅游助手，擅长路线规划、比价、挖掘宝藏地点。优先调用工具获取真实数据后回答，不编造。' }, ...conv],
          tools,
          tool_choice: 'auto',
        }),
      });
      if (!resp.ok) throw new Error('LLM HTTP ' + resp.status);
      const data = await resp.json();
      const msg = data.choices?.[0]?.message;
      if (!msg?.tool_calls) return { ok: true, source: 'llm', content: msg?.content || '（无回复）' };
      conv.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const fn = dispatch[tc.function.name];
        const args = JSON.parse(tc.function.arguments || '{}');
        const out = fn ? await fn(args) : '未知工具';
        conv.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
      }
    }
    return { ok: true, source: 'llm', content: '（规划较复杂，已为你分步处理，请告诉我更多偏好）' };
  } catch (e) {
    return ruleChat(messages);
  }
}

// 规则兜底：关键词匹配，复用已有能力
function ruleChat(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = (last?.content || '').toLowerCase();
  let reply;
  if (text.includes('路线') || text.includes('规划') || text.includes('去') || text.includes('行程')) {
    const names = getAllLocations().map((l) => l.name).filter((n) => text.includes(n));
    reply = optimizeRoute(names.length ? names : getAllLocations().slice(0, 3).map((l) => l.name));
  } else if (text.includes('宝藏') || text.includes('小众') || text.includes('美食') || text.includes('拍照')) {
    const city = getAllLocations().find((l) => text.includes(l.city))?.city || '当地';
    const kw = text.includes('美食') ? '美食' : text.includes('拍照') ? '拍照' : '小众';
    reply = '（规则助手）' + baiduMapSearchSync(kw, city);
  } else if (text.includes('价格') || text.includes('报价') || text.includes('多少钱')) {
    const name = getAllLocations().find((l) => text.includes(l.name))?.name;
    reply = name ? `「${name}」报价：${getPrice(name)}` : `可查地点：${listLocations()}`;
  } else {
    reply = `我是途见旅行助手~ 可以帮你：①规划路线（如"帮我规划三亚+成都5日游"）②比价 ③挖宝藏地点（如"成都小众美食"）。目前为离线规则模式，配置 DeepSeek Key 后能力更强。`;
  }
  return { ok: true, source: 'rule', content: reply };
}
function baiduMapSearchSync(keyword, city) {
  const mock = { 美食: ['巷子里的老字号面馆', '本地人私藏夜市'], 拍照: ['人少景美的城市天台', '老城区文艺巷弄'], 小众: ['冷门博物馆', '城郊秘境湿地公园'] };
  const key = mock[keyword] ? keyword : '小众';
  return `「${city}」的宝藏${keyword}：${mock[key].join('、')}`;
}
