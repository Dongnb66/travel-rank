// server.js —— Express 服务：REST API + 静态托管前端
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, getPostsByLocation, getPost, postVotesSum, votePost, createPost, findOrCreateLocation, getAllLocations, getPriceQuotes, pinLocation, getPostAdvantages, addComment, getComments, getOpsStats, getIdentities, sendMessage, getThread, getConversations, markThreadRead, getNotifications, markNotificationsRead, getUnreadCount, getUserProfile, getPostsByUser, getAllUsers, findUserByNickname, createVerifyCode, checkVerifyCode } from './src/db.js';
import { register, login, refresh, logout, authMiddleware, adminOnly, phoneRegister, phoneLogin, oauthLogin, bindCurrentUser, bindContact } from './src/auth.js';
import { sendVerifyCode, detectChannel, channelStatus } from './src/verify.js';
import { getLeaderboard, getHotPosts, buildRuleSummary } from './src/aggregator.js';
import { summarizeLocationLLM } from './src/llm.js';
import { planTrip } from './src/planner.js';
import { chatWithAgent } from './src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// 运营维护：结构化请求日志（方法 / 路径 / 状态码 / 耗时）
const BOOT_TIME = Date.now();
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

/* ============ 鉴权 ============ */
app.post('/api/register', (req, res) => {
  const r = register(req.body.nickname, req.body.password);
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/login', (req, res) => {
  const r = login(req.body.nickname, req.body.password);
  res.status(r.ok ? 200 : 401).json(r);
});
app.post('/api/refresh', (req, res) => {
  const r = refresh(req.body.refreshToken);
  res.status(r.ok ? 200 : 401).json(r);
});
app.post('/api/logout', (req, res) => {
  res.json(logout(req.body.refreshToken));
});
app.get('/api/me', authMiddleware, (req, res) => {
  const profile = getUserProfile(req.user.id);
  const unread = getUnreadCount(req.user.id);
  res.json({ ok: true, user: req.user, profile, unread });
});

/* ============ 个人主页 / 私信 / 通知 ============ */
app.get('/api/users', authMiddleware, (req, res) => {
  res.json({ ok: true, users: getAllUsers(req.user.id) });
});
app.get('/api/users/:id', (req, res) => {
  const profile = getUserProfile(Number(req.params.id));
  if (!profile) return res.status(404).json({ ok: false, error: '用户不存在' });
  res.json({ ok: true, profile, posts: getPostsByUser(profile.id) });
});
// 会话列表
app.get('/api/messages/conversations', authMiddleware, (req, res) => {
  res.json({ ok: true, conversations: getConversations(req.user.id) });
});
// 与某人的聊天记录（打开即已读）
app.get('/api/messages/thread/:userId', authMiddleware, (req, res) => {
  const other = Number(req.params.userId);
  markThreadRead(req.user.id, other);
  res.json({ ok: true, messages: getThread(req.user.id, other), other: getUserProfile(other) });
});
// 发私信
app.post('/api/messages', authMiddleware, (req, res) => {
  const { content, toUserId, toNickname } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ ok: false, error: '内容不能为空' });
  let toId = toUserId ? Number(toUserId) : null;
  if (!toId && toNickname) {
    const u = findUserByNickname(toNickname);
    if (!u) return res.status(404).json({ ok: false, error: '用户不存在' });
    toId = u.id;
  }
  if (!toId) return res.status(400).json({ ok: false, error: '缺少收件人' });
  if (toId === req.user.id) return res.status(400).json({ ok: false, error: '不能给自己发私信' });
  const id = sendMessage(req.user.id, toId, String(content).trim());
  res.json({ ok: true, id });
});
// 通知
app.get('/api/notifications', authMiddleware, (req, res) => {
  res.json({ ok: true, notifications: getNotifications(req.user.id) });
});
app.post('/api/notifications/read', authMiddleware, (req, res) => {
  markNotificationsRead(req.user.id);
  res.json({ ok: true });
});
// 未读数（顶栏红点）
app.get('/api/unread', authMiddleware, (req, res) => {
  res.json({ ok: true, unread: getUnreadCount(req.user.id) });
});

/* ============ 手机号 / 第三方登录 / 绑定 ============ */
app.post('/api/auth/phone/register', (req, res) => {
  const r = phoneRegister(req.body.phone, req.body.password, req.body.nickname);
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/auth/phone/login', (req, res) => {
  const r = phoneLogin(req.body.phone, req.body.password);
  res.status(r.ok ? 200 : 401).json(r);
});
// 微信 / QQ OAuth 回调（无 appid 时 code 直接当 openid，便于联调）
app.get('/api/auth/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  if (provider !== 'wechat' && provider !== 'qq') return res.status(400).json({ ok: false, error: '不支持的第三方' });
  const r = await oauthLogin(provider, req.query.code, req.query.target, req.query.verifyCode);
  res.status(r.ok || r.needBind ? 200 : 401).json(r);
});

/* ============ 验证码 + 第三方扫码登录（首次强制验证手机号/邮箱）============ */
// 发送验证码：邮箱配了 SMTP 就真发；否则演示模式把验证码回给前端
app.post('/api/verify/send', async (req, res) => {
  const { target, scene } = req.body || {};
  const channel = detectChannel(target);
  if (!channel) return res.status(400).json({ ok: false, error: '请输入正确的手机号或邮箱' });
  const sceneName = scene === 'third_login' ? 'third_login' : 'bind';
  const { code } = createVerifyCode(target, channel, sceneName);
  const r = await sendVerifyCode(target, channel, code);
  res.json({ ok: true, channel, scene: sceneName, delivered: r.delivered, devCode: r.devCode, expireSec: 300, fallback: r.fallback || false, reason: r.reason || '' });
});
// 通道状态：显示当前是真实下发还是演示模式（运维可观测）
app.get('/api/verify/channels', (req, res) => {
  res.json({ ok: true, channels: channelStatus() });
});
// 校验验证码
app.post('/api/verify/check', (req, res) => {
  const { target, code, scene } = req.body || {};
  const r = checkVerifyCode(target, code, scene === 'third_login' ? 'third_login' : 'bind');
  res.status(r.ok ? 200 : 400).json(r);
});
// 第三方扫码登录：已绑定直接进；首次需 target(手机号/邮箱) + verifyCode 完成验证并绑定
app.post('/api/auth/third/login', async (req, res) => {
  const { provider, code, target, verifyCode } = req.body || {};
  const r = await oauthLogin(provider, code, target, verifyCode);
  res.status(r.ok || r.needBind ? 200 : 401).json(r);
});
// 已登录用户绑定手机号 / 邮箱（需验证码）
app.post('/api/auth/contact/bind', authMiddleware, (req, res) => {
  const { target, verifyCode } = req.body || {};
  const r = bindContact(req.user.id, target, verifyCode);
  res.status(r.ok ? 200 : 400).json(r);
});
// 已登录用户绑定第三方 / 手机号
app.post('/api/auth/bind', authMiddleware, (req, res) => {
  const r = bindCurrentUser(req.user.id, req.body.provider, req.body.externalId);
  res.status(r.ok ? 200 : 400).json(r);
});
app.get('/api/auth/me/identities', authMiddleware, (req, res) => {
  res.json({ ok: true, identities: getIdentities(req.user.id) });
});

/* ============ AI 旅行助手（智能体 + 工具调用）============ */
app.post('/api/chat', authMiddleware, async (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (messages.length === 0) return res.status(400).json({ ok: false, error: '消息为空' });
  const r = await chatWithAgent(messages);
  res.json({ ok: true, reply: r.content, source: r.source });
});

/* ============ 社区评论 ============ */
app.get('/api/posts/:id/comments', (req, res) => {
  res.json({ ok: true, comments: getComments(Number(req.params.id)) });
});
app.post('/api/posts/:id/comments', authMiddleware, (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ ok: false, error: '评论内容为空' });
  const id = addComment(Number(req.params.id), req.user.id, content);
  res.json({ ok: true, commentId: id });
});

/* ============ 运营维护 ============ */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round((Date.now() - BOOT_TIME) / 1000), version: '1.0.0', time: new Date().toISOString() });
});
app.get('/api/admin/ops', authMiddleware, adminOnly, (req, res) => {
  res.json({ ok: true, stats: getOpsStats(), channels: channelStatus(), uptimeSec: Math.round((Date.now() - BOOT_TIME) / 1000) });
});

/* ============ 地点 ============ */
app.get('/api/locations', (req, res) => {
  res.json({ ok: true, locations: getAllLocations() });
});
app.post('/api/locations', authMiddleware, (req, res) => {
  const { name, city, category } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: '地点名称必填' });
  const id = findOrCreateLocation(name, city || '', category || '综合');
  res.json({ ok: true, locationId: id });
});

/* ============ 发帖 ============ */
app.post('/api/posts', authMiddleware, (req, res) => {
  const { locationId, title, content, pricePerDay, rating, advantages } = req.body;
  if (!locationId || !title || !content) {
    return res.status(400).json({ ok: false, error: '缺少地点/标题/内容' });
  }
  const r = createPost({
    userId: req.user.id,
    locationId,
    title,
    content,
    pricePerDay: pricePerDay ?? null,
    rating: rating ?? null,
    advantages: Array.isArray(advantages) ? advantages : [],
  });
  res.status(r.ok ? 200 : 400).json(r);
});
app.get('/api/posts', (req, res) => {
  const { locationId } = req.query;
  const posts = locationId ? getPostsByLocation(Number(locationId)) : getHotPosts(50);
  // 附带优点标签，便于前端展示与筛选
  res.json({ ok: true, posts: posts.map((p) => ({ ...p, advantages: getPostAdvantages(p.id) })) });
});
app.get('/api/posts/:id', (req, res) => {
  const p = getPost(Number(req.params.id));
  if (!p) return res.status(404).json({ ok: false, error: '帖子不存在' });
  p.advantages = getPostAdvantages(p.id);
  p.votes = postVotesSum(p.id);
  res.json({ ok: true, post: p });
});
app.post('/api/posts/:id/vote', authMiddleware, (req, res) => {
  const r = votePost(Number(req.params.id), req.user.id, req.body.value === -1 ? -1 : 1);
  res.json({ ...r, votes: postVotesSum(Number(req.params.id)) });
});

/* ============ 聚合排名 / AI 总结 ============ */
app.get('/api/leaderboard', (req, res) => {
  res.json({ ok: true, board: getLeaderboard() });
});
app.post('/api/summarize/:locationId', async (req, res) => {
  const lid = Number(req.params.locationId);
  const loc = db.prepare('SELECT name FROM locations WHERE id=?').get(lid);
  if (!loc) return res.status(404).json({ ok: false, error: '地点不存在' });
  const posts = db.prepare('SELECT title,content FROM posts WHERE location_id=?').all(lid);
  const r = await summarizeLocationLLM(lid, { locationName: loc.name, posts });
  res.json({ ok: true, location: loc.name, summary: r.text, source: r.source });
});
app.get('/api/hot', (req, res) => {
  res.json({ ok: true, posts: getHotPosts(10) });
});

/* ============ 价格比较 / 行程规划 ============ */
app.get('/api/price/:locationId', (req, res) => {
  res.json({ ok: true, quotes: getPriceQuotes(Number(req.params.locationId)) });
});
app.post('/api/plan', (req, res) => {
  const r = planTrip(req.body);
  res.status(r.ok ? 200 : 400).json(r);
});

/* ============ 管理员（RBAC 演示）============ */
app.post('/api/admin/locations/:id/pin', authMiddleware, adminOnly, (req, res) => {
  pinLocation(Number(req.params.id), req.body.pinned ? 1 : 0);
  res.json({ ok: true });
});

/* ============ 静态前端 ============ */
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🧭 旅游口碑平台已启动： http://localhost:${PORT}`);
});

export default app;
