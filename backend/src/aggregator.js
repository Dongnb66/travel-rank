// aggregator.js —— 聚合排名引擎（项目核心差异化能力）
// 把用户零散发帖 → 平台级「地点口碑榜」：热度排名 + 高频优点聚合 + 热门帖
import { db } from './db.js';

// 单个地点热度分：发帖数*2 + 总投票*3 + 平均评分*5（可调权重）
export function locationHeat(locationId) {
  const postCount = db.prepare('SELECT COUNT(*) c FROM posts WHERE location_id=?').get(locationId).c;
  const voteSum = db.prepare(
    `SELECT COALESCE(SUM(v.value),0) s FROM post_votes v JOIN posts p ON v.post_id=p.id WHERE p.location_id=?`
  ).get(locationId).s;
  const ratingRow = db.prepare('SELECT AVG(rating) a FROM posts WHERE location_id=? AND rating IS NOT NULL').get(locationId);
  const avgRating = ratingRow.a || 0;
  return postCount * 2 + voteSum * 3 + avgRating * 5;
}

// 聚合某地点被反复提到的优点（高频优先）—— 即「平台总结经常被提到优点的地点」
export function summarizeAdvantages(locationId, topN = 6) {
  return db.prepare(
    `SELECT pa.advantage AS name, COUNT(*) AS freq
     FROM post_advantages pa JOIN posts p ON pa.post_id = p.id
     WHERE p.location_id = ?
     GROUP BY pa.advantage
     ORDER BY freq DESC, name ASC
     LIMIT ?`
  ).all(locationId, topN);
}

// 热门帖（按投票降序），可限定地点
export function getHotPosts(limit = 10, locationId = null) {
  const sql = locationId
    ? `SELECT p.id,p.title,p.content,p.rating,p.created_at,l.name AS location,
              p.user_id, u.nickname AS author, u.avatar AS author_avatar,
              (SELECT COALESCE(SUM(value),0) FROM post_votes v WHERE v.post_id=p.id) AS votes
       FROM posts p JOIN locations l ON p.location_id=l.id
       JOIN users u ON p.user_id=u.id
       WHERE p.location_id=?
       ORDER BY votes DESC, p.created_at DESC LIMIT ?`
    : `SELECT p.id,p.title,p.content,p.rating,p.created_at,l.name AS location,
              p.user_id, u.nickname AS author, u.avatar AS author_avatar,
              (SELECT COALESCE(SUM(value),0) FROM post_votes v WHERE v.post_id=p.id) AS votes
       FROM posts p JOIN locations l ON p.location_id=l.id
       JOIN users u ON p.user_id=u.id
       ORDER BY votes DESC, p.created_at DESC LIMIT ?`;
  return locationId ? db.prepare(sql).all(locationId, limit) : db.prepare(sql).all(limit);
}

// 平台总榜：所有地点按热度排名，附带高频优点与热门帖
export function getLeaderboard() {
  const locs = db.prepare('SELECT id,name,city,category,pinned FROM locations').all();
  const board = locs.map((l) => {
    const heat = locationHeat(l.id);
    const advantages = summarizeAdvantages(l.id, 6);
    const hot = getHotPosts(3, l.id);
    const postCount = db.prepare('SELECT COUNT(*) c FROM posts WHERE location_id=?').get(l.id).c;
    return {
      ...l,
      heat: Math.round(heat * 10) / 10,
      postCount,
      topAdvantages: advantages,
      hotPosts: hot,
    };
  });
  // 置顶(pinned)优先，其次按热度降序
  board.sort((a, b) => (b.pinned - a.pinned) || (b.heat - a.heat));
  return board;
}

// 给某地点生成一句「平台总结」文本（规则版，llm.js 会优先用大模型重写）
export function buildRuleSummary(locationId) {
  const loc = db.prepare('SELECT name FROM locations WHERE id=?').get(locationId);
  if (!loc) return null;
  const advs = summarizeAdvantages(locationId, 5);
  const postCount = db.prepare('SELECT COUNT(*) c FROM posts WHERE location_id=?').get(locationId).c;
  const voteSum = db.prepare(
    `SELECT COALESCE(SUM(v.value),0) s FROM post_votes v JOIN posts p ON v.post_id=p.id WHERE p.location_id=?`
  ).get(locationId).s;
  if (postCount === 0) return `${loc.name} 暂无用户分享，快来做第一个推荐人吧！`;
  const advText = advs.map((a) => a.name).join('、');
  return `${loc.name} 被 ${postCount} 篇帖子推荐、累计 ${voteSum} 个赞，高频优点：${advText}。`;
}
