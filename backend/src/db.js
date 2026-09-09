// db.js —— 数据层（node:sqlite 内置，无需原生编译）
// 负责：建表、种子数据、密码哈希、所有读写辅助函数
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.TRAVEL_DB || path.join(__dirname, 'travel.db');

export const db = new DatabaseSync(DB_PATH);
// 开启外键与 WAL，提升并发读写表现
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

/* ============ 建表 ============ */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  avatar TEXT DEFAULT '🧳',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expired_at INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT,
  category TEXT DEFAULT '综合',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_loc_city ON locations(city);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  price_per_day INTEGER,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_post_loc ON posts(location_id);
CREATE INDEX IF NOT EXISTS idx_post_time ON posts(created_at);

CREATE TABLE IF NOT EXISTS post_advantages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  advantage TEXT NOT NULL,
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_adv_post ON post_advantages(post_id);

CREATE TABLE IF NOT EXISTS post_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  value INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, user_id),
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS price_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  price INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE CASCADE
);

-- 账号身份绑定：同一用户可绑定 手机号 / 微信 / QQ 等多种登录方式
CREATE TABLE IF NOT EXISTS user_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,           -- phone / wechat / qq
  external_id TEXT NOT NULL,        -- 手机号 或 第三方 openid
  verified INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, external_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ident_user ON user_identities(user_id);

-- 社区：帖子评论
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comment_post ON comments(post_id);

-- 私信：用户之间一对一聊天
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(from_user) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(to_user) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_user, to_user);
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_user, is_read);

-- 通知：评论回复、点赞等系统消息
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref_id INTEGER,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ntf_user ON notifications(user_id, is_read);

-- 验证码：绑定手机号/邮箱、第三方登录强制验证时使用（只存哈希，不存明文）
CREATE TABLE IF NOT EXISTS verify_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  channel TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  scene TEXT NOT NULL,
  expired_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vc_target ON verify_codes(target, scene);
`);

/* ============ 密码哈希（scrypt，纯 Node 原生）============ */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${h}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const hh = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hh, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ============ 用户 ============ */
export function createUser(nickname, password, role = 'user', avatar = '🧳') {
  const info = db.prepare(
    'INSERT INTO users(nickname, password_hash, role, avatar) VALUES (?,?,?,?)'
  ).run(nickname, hashPassword(password), role, avatar);
  return info.lastInsertRowid;
}
export function findUserByNickname(nickname) {
  return db.prepare('SELECT * FROM users WHERE nickname=?').get(nickname);
}
export function findUserById(id) {
  return db.prepare('SELECT id,nickname,role,avatar,created_at FROM users WHERE id=?').get(id);
}
// 仅服务端校验用：返回含 password_hash 的行（勿直接返回前端）
export function getUserSecret(id) {
  return db.prepare('SELECT id,nickname,role,avatar,password_hash FROM users WHERE id=?').get(id);
}

/* ============ Refresh Token（双 token 吊销）============ */
export function insertRefreshToken(userId, tokenHash, ttlMs) {
  const expiredAt = Date.now() + ttlMs;
  db.prepare('INSERT INTO refresh_tokens(user_id,token_hash,expired_at) VALUES (?,?,?)')
    .run(userId, tokenHash, expiredAt);
}
export function getRefreshTokenRow(tokenHash) {
  return db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=?').get(tokenHash);
}
export function deleteRefreshToken(tokenHash) {
  db.prepare('DELETE FROM refresh_tokens WHERE token_hash=?').run(tokenHash);
}
export function deleteAllRefreshTokens(userId) {
  db.prepare('DELETE FROM refresh_tokens WHERE user_id=?').run(userId);
}

/* ============ 地点 ============ */
export function findOrCreateLocation(name, city, category = '综合') {
  const existing = db.prepare('SELECT id FROM locations WHERE name=?').get(name);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO locations(name,city,category) VALUES (?,?,?)').run(name, city, category);
  return info.lastInsertRowid;
}
export function getAllLocations() {
  return db.prepare('SELECT id,name,city,category,pinned FROM locations ORDER BY id').all();
}
export function getLocation(id) {
  return db.prepare('SELECT * FROM locations WHERE id=?').get(id);
}
export function pinLocation(id, pinned = 1) {
  db.prepare('UPDATE locations SET pinned=? WHERE id=?').run(pinned ? 1 : 0, id);
}

/* ============ 发帖（事务：帖 + 优点标签 原子写入）============ */
export function createPost({ userId, locationId, title, content, pricePerDay, rating, advantages = [] }) {
  const tx = db.prepare('SELECT 1'); // 仅占位，真正事务用 exec
  try {
    db.exec('BEGIN');
    const info = db.prepare(
      `INSERT INTO posts(user_id,location_id,title,content,price_per_day,rating)
       VALUES (?,?,?,?,?,?)`
    ).run(userId, locationId, title, content, pricePerDay ?? null, rating ?? null);
    const postId = info.lastInsertRowid;
    const ins = db.prepare('INSERT INTO post_advantages(post_id,advantage) VALUES (?,?)');
    for (const adv of advantages) {
      const a = String(adv).trim();
      if (a) ins.run(postId, a);
    }
    db.exec('COMMIT');
    return { ok: true, postId };
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, error: e.message };
  }
}
export function getPost(id) {
  return db.prepare(
    `SELECT p.*, u.nickname AS author, u.avatar AS author_avatar, l.name AS location_name, l.city AS location_city
     FROM posts p JOIN users u ON p.user_id=u.id JOIN locations l ON p.location_id=l.id
     WHERE p.id=?`
  ).get(id);
}
export function getPostsByLocation(locationId) {
  return db.prepare(
    `SELECT p.id,p.title,p.content,p.price_per_day,p.rating,p.created_at,
            u.nickname AS author, u.avatar AS author_avatar,
            (SELECT COALESCE(SUM(value),0) FROM post_votes v WHERE v.post_id=p.id) AS votes
     FROM posts p JOIN users u ON p.user_id=u.id
     WHERE p.location_id=?
     ORDER BY votes DESC, p.created_at DESC`
  ).all(locationId);
}
export function getPostsByUser(userId) {
  return db.prepare('SELECT id,title,location_id,rating,created_at FROM posts WHERE user_id=? ORDER BY created_at DESC').all(userId);
}
export function getPostAdvantages(postId) {
  return db.prepare('SELECT advantage FROM post_advantages WHERE post_id=? ORDER BY id').all(postId).map((r) => r.advantage);
}

/* ============ 账号身份绑定（手机号 / 微信 / QQ）============ */
// 用手机号+密码注册：建用户 + 绑定 phone 身份
export function registerWithPhone(phone, password, nickname) {
  const info = db.prepare('INSERT INTO users(nickname, password_hash, avatar) VALUES (?,?,?)')
    .run(nickname || `用户${phone.slice(-4)}`, hashPassword(password), '🧳');
  const uid = info.lastInsertRowid;
  db.prepare('INSERT INTO user_identities(user_id, provider, external_id, verified) VALUES (?,?,?,?)')
    .run(uid, 'phone', phone, 1);
  return uid;
}
export function findIdentity(provider, externalId) {
  return db.prepare('SELECT * FROM user_identities WHERE provider=? AND external_id=?').get(provider, externalId);
}
export function bindIdentity(userId, provider, externalId) {
  // 同一第三方身份若已绑别人则忽略；同一用户重复绑同平台则更新
  const existing = db.prepare('SELECT * FROM user_identities WHERE provider=? AND external_id=?').get(provider, externalId);
  if (existing && existing.user_id !== userId) return { ok: false, error: '该账号已被其他用户绑定' };
  db.prepare('INSERT OR REPLACE INTO user_identities(user_id, provider, external_id, verified) VALUES (?,?,?,1)')
    .run(userId, provider, externalId);
  return { ok: true };
}
export function getIdentities(userId) {
  return db.prepare('SELECT provider, external_id, verified FROM user_identities WHERE user_id=?').all(userId);
}

/* ============ 社区评论 ============ */
export function addComment(postId, userId, content) {
  const info = db.prepare('INSERT INTO comments(post_id, user_id, content) VALUES (?,?,?)').run(postId, userId, content);
  // 评论后通知帖子作者（自己评论自己不通知）
  const post = db.prepare('SELECT user_id, title FROM posts WHERE id=?').get(postId);
  if (post && post.user_id !== userId) {
    const from = db.prepare('SELECT nickname FROM users WHERE id=?').get(userId);
    addNotification(post.user_id, 'comment', postId, `${from?.nickname || '有人'} 评论了你的帖子《${post.title}》`);
  }
  return info.lastInsertRowid;
}
export function getComments(postId) {
  return db.prepare(
    `SELECT c.id, c.content, c.created_at, u.nickname AS author, u.avatar
     FROM comments c JOIN users u ON c.user_id=u.id
     WHERE c.post_id=? ORDER BY c.created_at ASC`
  ).all(postId);
}

/* ============ 私信（用户之间聊天）============ */
export function sendMessage(fromId, toId, content) {
  const info = db.prepare('INSERT INTO messages(from_user,to_user,content) VALUES (?,?,?)').run(fromId, toId, content);
  return info.lastInsertRowid;
}
export function getThread(userId, otherId) {
  return db.prepare(
    `SELECT m.id, m.content, m.created_at, m.from_user, m.is_read,
            fu.nickname AS from_nick, fu.avatar AS from_avatar
     FROM messages m JOIN users fu ON m.from_user=fu.id
     WHERE (m.from_user=? AND m.to_user=?) OR (m.from_user=? AND m.to_user=?)
     ORDER BY m.created_at ASC`
  ).all(userId, otherId, otherId, userId);
}
// 会话列表：每个聊过的对象一条，含最后一条消息与未读数
export function getConversations(userId) {
  return db.prepare(
    `SELECT u.id AS user_id, u.nickname, u.avatar,
            (SELECT content FROM messages
             WHERE (from_user=u.id AND to_user=?) OR (from_user=? AND to_user=u.id)
             ORDER BY created_at DESC LIMIT 1) AS last_content,
            (SELECT created_at FROM messages
             WHERE (from_user=u.id AND to_user=?) OR (from_user=? AND to_user=u.id)
             ORDER BY created_at DESC LIMIT 1) AS last_at,
            (SELECT COUNT(*) FROM messages WHERE from_user=u.id AND to_user=? AND is_read=0) AS unread
     FROM users u
     WHERE u.id != ? AND EXISTS (
       SELECT 1 FROM messages m
       WHERE (m.from_user=u.id AND m.to_user=?) OR (m.from_user=? AND m.to_user=u.id)
     )
     ORDER BY last_at DESC`
  ).all(userId, userId, userId, userId, userId, userId, userId, userId);
}
export function markThreadRead(userId, otherId) {
  db.prepare('UPDATE messages SET is_read=1 WHERE from_user=? AND to_user=? AND is_read=0').run(otherId, userId);
}

/* ============ 通知（评论/互动提醒）============ */
export function addNotification(userId, type, refId, content) {
  const info = db.prepare('INSERT INTO notifications(user_id,type,ref_id,content) VALUES (?,?,?,?)')
    .run(userId, type, refId, content);
  return info.lastInsertRowid;
}
export function getNotifications(userId) {
  return db.prepare(
    'SELECT id, type, ref_id, content, created_at, is_read FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50'
  ).all(userId);
}
export function markNotificationsRead(userId) {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0').run(userId);
}
export function getUnreadCount(userId) {
  const msg = db.prepare('SELECT COUNT(*) c FROM messages WHERE to_user=? AND is_read=0').get(userId).c;
  const ntf = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(userId).c;
  return { messages: msg, notifications: ntf, total: msg + ntf };
}

/* ============ 验证码（绑定手机号 / 邮箱、第三方登录强制验证）============ */
export function createVerifyCode(target, channel, scene, ttlMs = 5 * 60 * 1000) {
  const code = String(crypto.randomInt(100000, 999999));
  const codeHash = crypto.createHash('sha256').update(`${target}|${code}`).digest('hex');
  // 同一 target + scene 的旧验证码全部作废，防止并存
  db.prepare('UPDATE verify_codes SET used=1 WHERE target=? AND scene=? AND used=0').run(target, scene);
  db.prepare('INSERT INTO verify_codes(target,channel,code_hash,scene,expired_at) VALUES (?,?,?,?,?)')
    .run(target, channel, codeHash, scene, Date.now() + ttlMs);
  return { code, expiredAt: Date.now() + ttlMs };
}
export function checkVerifyCode(target, code, scene) {
  const row = db.prepare(
    'SELECT id, code_hash, expired_at, used FROM verify_codes WHERE target=? AND scene=? ORDER BY id DESC LIMIT 1'
  ).get(target, scene);
  if (!row) return { ok: false, error: '请先获取验证码' };
  if (row.used) return { ok: false, error: '验证码已使用，请重新获取' };
  if (row.expired_at < Date.now()) return { ok: false, error: '验证码已过期，请重新获取' };
  const hash = crypto.createHash('sha256').update(`${target}|${String(code)}`).digest('hex');
  if (hash !== row.code_hash) return { ok: false, error: '验证码不正确' };
  db.prepare('UPDATE verify_codes SET used=1 WHERE id=?').run(row.id);
  return { ok: true };
}

/* ============ 个人主页 ============ */
export function getUserProfile(userId) {
  const u = db.prepare('SELECT id, nickname, avatar, role, created_at FROM users WHERE id=?').get(userId);
  if (!u) return null;
  const posts = db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=?').get(userId).c;
  const comments = db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id=?').get(userId).c;
  const likes = db.prepare(
    `SELECT COALESCE(SUM(pv.value),0) s FROM post_votes pv JOIN posts p ON pv.post_id=p.id WHERE p.user_id=?`
  ).get(userId).s;
  return { ...u, stats: { posts, comments, likes } };
}
export function getAllUsers(exceptId) {
  return db.prepare('SELECT id, nickname, avatar FROM users WHERE id != ? ORDER BY id').all(exceptId ?? -1);
}

/* ============ 运维统计（运营维护）============ */
export function getOpsStats() {
  const tables = ['users', 'locations', 'posts', 'post_advantages', 'post_votes', 'price_quotes', 'comments', 'user_identities'];
  const counts = {};
  for (const t of tables) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { counts[t] = 0; }
  }
  const lastPost = db.prepare('SELECT created_at FROM posts ORDER BY created_at DESC LIMIT 1').get();
  const topLocation = db.prepare(
    `SELECT l.name, COUNT(*) c FROM posts p JOIN locations l ON p.location_id=l.id GROUP BY l.id ORDER BY c DESC LIMIT 1`
  ).get();
  return { counts, lastActivity: lastPost?.created_at || null, hottestLocation: topLocation || null };
}

/* ============ 投票 ============ */
export function votePost(postId, userId, value = 1) {
  const existing = db.prepare('SELECT id,value FROM post_votes WHERE post_id=? AND user_id=?').get(postId, userId);
  if (existing) {
    if (existing.value === value) {
      db.prepare('DELETE FROM post_votes WHERE id=?').run(existing.id); // 再次点击取消
      return { ok: true, action: 'cancel' };
    }
    db.prepare('UPDATE post_votes SET value=? WHERE id=?').run(value, existing.id);
    return { ok: true, action: 'update' };
  }
  db.prepare('INSERT INTO post_votes(post_id,user_id,value) VALUES (?,?,?)').run(postId, userId, value);
  return { ok: true, action: 'add' };
}
export function postVotesSum(postId) {
  const r = db.prepare('SELECT COALESCE(SUM(value),0) AS s FROM post_votes WHERE post_id=?').get(postId);
  return r ? r.s : 0;
}

/* ============ 价格比较 ============ */
export function insertPriceQuote(locationId, provider, price, durationDays) {
  db.prepare('INSERT INTO price_quotes(location_id,provider,price,duration_days) VALUES (?,?,?,?)')
    .run(locationId, provider, price, durationDays);
}
export function getPriceQuotes(locationId) {
  return db.prepare('SELECT provider,price,duration_days FROM price_quotes WHERE location_id=? ORDER BY price ASC').all(locationId);
}

/* ============ 种子数据 ============ */
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount > 0) return; // 已初始化则跳过

  // 用户
  const u1 = createUser('旅行者小明', 'travel123', 'user', '🧭');
  const u2 = createUser('吃货阿珍', 'travel123', 'user', '🍜');
  const u3 = createUser('背包客老周', 'travel123', 'user', '🎒');
  createUser('平台管理员', 'admin123', 'admin', '🛡️');

  // 地点
  const loc = {
    三亚: findOrCreateLocation('三亚', '海南', '海滨'),
    成都: findOrCreateLocation('成都', '四川', '美食'),
    西安: findOrCreateLocation('西安', '陕西', '历史'),
    重庆: findOrCreateLocation('重庆', '重庆', '美食'),
    大理: findOrCreateLocation('大理', '云南', '自然'),
    杭州: findOrCreateLocation('杭州', '浙江', '人文'),
  };

  // 发帖：地点 -> 帖子(标题, 内容, 日均价, 评分, 优点[])
  const seedPosts = [
    [loc['三亚'], u1, '三亚看海天花板', '亚龙湾海水清澈，适合浮潜，傍晚海滩日落绝美。', 600, 5, ['海水清澈', '日落好看', '适合浮潜', '度假感强']],
    [loc['三亚'], u2, '三亚吃海鲜不踩雷', '第一市场加工店多，价格透明，和乐蟹很肥美。', 550, 4, ['海鲜便宜', '美食多', '价格透明']],
    [loc['成都'], u2, '成都美食暴走指南', '宽窄巷子游客多，但玉林路小酒馆和苍蝇馆子更地道，火锅必吃。', 300, 5, ['美食多', '火锅好吃', '生活节奏慢', '性价比高']],
    [loc['成都'], u3, '成都周边徒步', '都江堰-青城山一天搞定，爬山不累，空气好。', 280, 4, ['空气好', '适合徒步', '人文浓厚']],
    [loc['西安'], u3, '西安历史感拉满', '兵马俑必看，城墙骑行很爽，回民街小吃密集。', 320, 5, ['历史厚重', '小吃多', '城墙骑行', '人文浓厚']],
    [loc['西安'], u1, '西安住哪方便', '钟楼附近交通最方便，去哪都近，地铁直达。', 350, 4, ['交通便利', '位置中心', '性价比高']],
    [loc['重庆'], u2, '重庆8D魔幻城市', '洪崖洞夜景封神，轻轨穿楼很神奇，火锅便宜大碗。', 330, 5, ['夜景美', '火锅好吃', '魔幻地形', '美食多']],
    [loc['重庆'], u3, '重庆周边游', '武隆天坑地缝值得去，天生三桥很震撼。', 400, 4, ['自然奇观', '适合徒步', '空气好']],
    [loc['大理'], u1, '大理风花雪月', '洱海骑行超治愈，双廊看海，苍山雪景也好看。', 380, 5, ['洱海美', '适合骑行', '治愈', '空气好']],
    [loc['大理'], u2, '大理慢生活', '古城咖啡馆多，发呆一整天，物价不高。', 360, 4, ['生活节奏慢', '咖啡馆多', '性价比高', '治愈']],
    [loc['杭州'], u3, '杭州西湖必去', '西湖免费，断桥残雪四季都好看，龙井茶便宜。', 400, 5, ['西湖美', '免费景点', '茶文化', '人文浓厚']],
    [loc['杭州'], u1, '杭州周边古镇', '西塘乌镇都近，坐高铁半小时，水乡味道足。', 420, 4, ['水乡美', '交通便利', '适合骑行']],
  ];
  for (const [lid, uid, title, content, price, rating, advs] of seedPosts) {
    const r = createPost({ userId: uid, locationId: lid, title, content, pricePerDay: price, rating, advantages: advs });
    // 给部分帖子一些初始投票，制造热度差
    const pid = r.postId;
    if (['三亚看海天花板', '成都美食暴走指南', '重庆8D魔幻城市', '西安历史感拉满', '大理风花雪月', '杭州西湖必去'].includes(title)) {
      db.prepare('INSERT INTO post_votes(post_id,user_id,value) VALUES (?,?,1)').run(pid, u2 === uid ? u1 : u2);
      db.prepare('INSERT INTO post_votes(post_id,user_id,value) VALUES (?,?,1)').run(pid, u3);
    }
  }

  // 价格比较种子（同一地点不同平台/方式报价）
  const quotes = [
    [loc['三亚'], '经济跟团', 1280, 3], [loc['三亚'], '自由行机酒', 2100, 3], [loc['三亚'], '高端定制', 4500, 3],
    [loc['成都'], '高铁自由行', 980, 3], [loc['成都'], '当地拼团', 760, 3], [loc['成都'], '深度定制', 2200, 4],
    [loc['西安'], '高铁自由行', 1050, 3], [loc['西安'], '历史研学团', 1680, 4],
    [loc['重庆'], '周末游套餐', 880, 2], [loc['重庆'], '自由行机酒', 1500, 3],
    [loc['大理'], '洱海民宿套餐', 1360, 3], [loc['大理'], '环线自驾', 1980, 4],
    [loc['杭州'], '高铁一日', 620, 1], [loc['杭州'], '周末深度', 1280, 2],
  ];
  for (const [lid, provider, price, days] of quotes) insertPriceQuote(lid, provider, price, days);

  // 社区评论种子
  const seedPost = db.prepare('SELECT id FROM posts LIMIT 1').get();
  if (seedPost) {
    db.prepare('INSERT INTO comments(post_id,user_id,content) VALUES (?,?,?)').run(seedPost.id, u1, '去过，确实不错，按你说的路线走的！');
    db.prepare('INSERT INTO comments(post_id,user_id,content) VALUES (?,?,?)').run(seedPost.id, u2, '求详细攻略，想周末去~');
  }

  // 私信种子：让"旅行者小明"一登录就有未读消息
  if (u1 && u2) {
    db.prepare('INSERT INTO messages(from_user,to_user,content) VALUES (?,?,?)')
      .run(u2, u1, '你那篇三亚攻略太有用了！想问下亚龙湾浮潜要提前订吗？');
    db.prepare('INSERT INTO messages(from_user,to_user,content) VALUES (?,?,?)')
      .run(u1, u2, '要的，旺季建议提前 2 天订，能便宜不少～');
    db.prepare('INSERT INTO messages(from_user,to_user,content) VALUES (?,?,?)')
      .run(u2, u1, '好嘞谢谢！再问下第一市场哪家海鲜加工靠谱？');
  }

  // 通知种子：评论提醒
  const firstPost = db.prepare('SELECT id, user_id, title FROM posts ORDER BY id LIMIT 1').get();
  if (firstPost) {
    db.prepare('INSERT INTO notifications(user_id,type,ref_id,content) VALUES (?,?,?,?)')
      .run(firstPost.user_id, 'comment', firstPost.id, `吃货阿珍 评论了你的帖子《${firstPost.title}》`);
    db.prepare('INSERT INTO notifications(user_id,type,ref_id,content) VALUES (?,?,?,?)')
      .run(firstPost.user_id, 'comment', firstPost.id, `背包客老周 也评论了你的帖子《${firstPost.title}》`);
  }

  console.log('[seed] 旅游平台示例数据已初始化：6 地点 / 12 帖 / 价格比较 / 评论 / 私信 / 通知 已就绪');
}
seed();

export default db;
