// planner.js —— 行程规划 + 价格比较（"帮你选路线、比价格"的核心）
import { db, getPriceQuotes } from './db.js';

// 为单个目的地挑选最优报价：优先天数匹配，否则取最低价
function pickBestQuote(locationId, days) {
  const quotes = getPriceQuotes(locationId);
  if (quotes.length === 0) return null;
  const exact = quotes.find((q) => q.duration_days === days);
  const best = exact || quotes[0]; // getPriceQuotes 已按 price ASC 排序
  return best;
}

// 规划主函数
// input: { destinations: [{ locationId, days }], budget?: number }
export function planTrip(input) {
  const dests = Array.isArray(input?.destinations) ? input.destinations : [];
  if (dests.length === 0) return { ok: false, error: '请至少选择一个目的地' };
  const budget = Number(input.budget) || null;

  const stops = [];
  let totalCost = 0;
  for (const d of dests) {
    const loc = db.prepare('SELECT id,name,city,category FROM locations WHERE id=?').get(d.locationId);
    if (!loc) continue;
    const days = Math.max(1, Number(d.days) || 3);
    const quote = pickBestQuote(loc.id, days);
    const cost = quote ? Math.round(quote.price * (days / quote.duration_days)) : null;
    if (cost) totalCost += cost;
    const allQuotes = getPriceQuotes(loc.id);
    stops.push({
      locationId: loc.id,
      name: loc.name,
      city: loc.city,
      category: loc.category,
      days,
      chosenProvider: quote ? quote.provider : null,
      chosenPrice: quote ? quote.price : null,
      estCost: cost,
      comparison: allQuotes, // 全部报价，供前端比价展示
    });
  }

  // 智能排序路线：同城市相邻、城市内按日均性价比（评分/价格）降序
  const ratingOf = (id) =>
    db.prepare('SELECT AVG(rating) a FROM posts WHERE location_id=? AND rating IS NOT NULL').get(id).a || 3;
  stops.sort((a, b) => {
    if (a.city !== b.city) return a.city < b.city ? -1 : 1; // 同城集中，减少跨城奔波
    const ra = ratingOf(a.locationId) / (a.chosenPrice || 9999);
    const rb = ratingOf(b.locationId) / (b.chosenPrice || 9999);
    return rb - ra;
  });

  let recommendation;
  if (budget == null) {
    recommendation = `已为你规划 ${stops.length} 站路线，预计总花费约 ¥${totalCost}。`;
  } else if (totalCost <= budget) {
    recommendation = `预算 ¥${budget} 充足，本路线预计 ¥${totalCost}，还可酌情升级住宿或增加天数。`;
  } else {
    const over = totalCost - budget;
    recommendation = `预算 ¥${budget} 不足，超出约 ¥${over}。建议：缩短天数、改选更低价套餐，或删减 1 站非核心目的地。`;
  }

  return {
    ok: true,
    route: stops.map((s) => s.name),
    stops,
    totalCost,
    budget,
    recommendation,
  };
}
