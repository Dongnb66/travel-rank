// auth.js —— 鉴权（Node 原生 crypto 实现 JWT 双 token + RBAC）
// 说明：用 HMAC-SHA256 自签 token，不依赖 jsonwebtoken；密码用 scrypt（见 db.js）
import crypto from 'node:crypto';
import {
  findUserByNickname,
  findUserById,
  getUserSecret,
  createUser,
  registerWithPhone,
  findIdentity,
  bindIdentity,
  insertRefreshToken,
  getRefreshTokenRow,
  deleteRefreshToken,
  hashPassword,
  verifyPassword,
  checkVerifyCode,
} from './db.js';
import { detectChannel } from './verify.js';

const SECRET = process.env.TRAVEL_SECRET || 'travel-rank-dev-secret';
const ACCESS_TTL = 2 * 60 * 60 * 1000;      // access token 2 小时
const REFRESH_TTL = 7 * 24 * 60 * 60 * 1000; // refresh token 7 天

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function sign(payload) {
  const body = b64url(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// 统一签发双 token
export function issueTokens(u) {
  const access = sign({ uid: u.id, nickname: u.nickname, role: u.role, exp: Date.now() + ACCESS_TTL });
  const refresh = sign({ uid: u.id, type: 'refresh', exp: Date.now() + REFRESH_TTL });
  const refreshHash = crypto.createHash('sha256').update(refresh).digest('hex');
  insertRefreshToken(u.id, refreshHash, REFRESH_TTL);
  return {
    ok: true,
    accessToken: access,
    refreshToken: refresh,
    user: { id: u.id, nickname: u.nickname, role: u.role, avatar: u.avatar },
  };
}

export function register(nickname, password, role = 'user') {
  if (!nickname || !password) return { ok: false, error: '昵称与密码必填' };
  if (findUserByNickname(nickname)) return { ok: false, error: '昵称已存在' };
  const id = createUser(nickname, password, role);
  return { ok: true, userId: id };
}

export function login(nickname, password) {
  const u = findUserByNickname(nickname);
  if (!u || !verifyPassword(password, u.password_hash)) {
    return { ok: false, error: '昵称或密码错误' };
  }
  return issueTokens(u);
}

/* ============ 手机号注册 / 登录 ============ */
export function phoneRegister(phone, password, nickname) {
  if (!/^1\d{10}$/.test(phone)) return { ok: false, error: '手机号格式不正确' };
  if (findIdentity('phone', phone)) return { ok: false, error: '该手机号已注册' };
  const uid = registerWithPhone(phone, password, nickname);
  const u = findUserById(uid);
  return issueTokens(u);
}
export function phoneLogin(phone, password) {
  const ident = findIdentity('phone', phone);
  if (!ident) return { ok: false, error: '该手机号未注册' };
  const u = getUserSecret(ident.user_id);
  if (!u || !verifyPassword(password, u.password_hash)) return { ok: false, error: '手机号或密码错误' };
  return issueTokens(u);
}

/* ============ 第三方 OAuth（微信 / QQ）脚手架 ============ */
// 真实环境：用 code 换 openid（需配置 WECHAT_APPID/SECRET 或 QQ_APPID/SECRET）。
// 未配置时进入 mock 模式：直接把 code 当作 openid，方便本地联调与测试。
async function codeToOpenid(provider, code) {
  const appid = process.env[provider === 'wechat' ? 'WECHAT_APPID' : 'QQ_APPID'];
  const secret = process.env[provider === 'wechat' ? 'WECHAT_SECRET' : 'QQ_SECRET'];
  if (!appid || !secret || !code) return code; // mock
  const url = provider === 'wechat'
    ? `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appid}&secret=${secret}&code=${code}&grant_type=authorization_code`
    : `https://graph.qq.com/oauth2.0/token?grant_type=authorization_code&client_id=${appid}&client_secret=${secret}&code=${code}&redirect_uri=${process.env.QQ_REDIRECT || ''}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    return d.openid || d.openid; // 真实返回 openid
  } catch {
    return code; // 失败降级 mock
  }
}
// 第三方登录（微信 / QQ 扫码）
// 已绑定过 → 直接登录；首次使用 → 必须先用「手机号或邮箱 + 验证码」完成验证，才允许建号并绑定第三方
export async function oauthLogin(provider, code, target, verifyCode) {
  if (!['wechat', 'qq'].includes(provider)) return { ok: false, error: '不支持的第三方' };
  const openid = await codeToOpenid(provider, code);
  if (!openid) return { ok: false, needBind: true, error: '授权失败，请重新扫码' };

  const ident = findIdentity(provider, openid);
  if (ident) {
    // 该微信/QQ 已绑定过账号 → 直接登录
    const u = findUserById(ident.user_id);
    return issueTokens(u);
  }

  // 首次扫码：要求验证手机号或邮箱
  if (!target || !verifyCode) {
    return {
      ok: false,
      needBind: true,
      provider,
      openid,
      error: '首次使用微信/QQ 登录，请先绑定手机号或邮箱完成验证',
    };
  }
  const channel = detectChannel(target);
  if (!channel) return { ok: false, needBind: true, error: '请输入正确的手机号或邮箱' };
  const v = checkVerifyCode(target, verifyCode, 'third_login');
  if (!v.ok) return { ok: false, needBind: true, error: v.error };

  // 该手机号/邮箱若已属于某个账号 → 直接复用，再挂上第三方；否则新建账号
  const exist = findIdentity(channel, target);
  let uid;
  if (exist) {
    uid = exist.user_id;
  } else {
    uid = createUser(
      `${provider === 'wechat' ? '微信' : 'QQ'}用户${openid.slice(0, 4)}`,
      crypto.randomBytes(12).toString('hex'),
      'user',
      '🧳'
    );
  }
  bindIdentity(uid, channel, target);
  bindIdentity(uid, provider, openid);
  const u = findUserById(uid);
  return issueTokens(u);
}

// 已登录用户绑定手机号 / 邮箱（需验证码验证）
export function bindContact(userId, target, verifyCode) {
  const channel = detectChannel(target);
  if (!channel) return { ok: false, error: '请输入正确的手机号或邮箱' };
  const v = checkVerifyCode(target, verifyCode, 'bind');
  if (!v.ok) return { ok: false, error: v.error };
  if (findIdentity(channel, target)) {
    return { ok: false, error: channel === 'email' ? '该邮箱已被绑定' : '该手机号已被绑定' };
  }
  bindIdentity(userId, channel, target);
  return { ok: true, channel };
}
// 已登录用户绑定第三方账号
export function bindCurrentUser(userId, provider, externalId) {
  return bindIdentity(userId, provider, externalId);
}

export function refresh(refreshToken) {
  const payload = verify(refreshToken);
  if (!payload || payload.type !== 'refresh') return { ok: false, error: 'refresh token 无效' };
  const row = getRefreshTokenRow(crypto.createHash('sha256').update(refreshToken).digest('hex'));
  if (!row || row.expired_at < Date.now()) return { ok: false, error: 'refresh token 已过期或吊销' };
  const u = findUserById(payload.uid);
  if (!u) return { ok: false, error: '用户不存在' };
  const access = sign({ uid: u.id, nickname: u.nickname, role: u.role, exp: Date.now() + ACCESS_TTL });
  return { ok: true, accessToken: access, user: u };
}

export function logout(refreshToken) {
  if (refreshToken) deleteRefreshToken(crypto.createHash('sha256').update(refreshToken).digest('hex'));
  return { ok: true };
}

// Express 中间件：解析 Authorization: Bearer <token>
export function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = verify(token);
  if (!payload) return res.status(401).json({ ok: false, error: '未登录或登录已过期' });
  req.user = { id: payload.uid, nickname: payload.nickname, role: payload.role };
  next();
}

// RBAC：仅 admin 可访问
export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
  next();
}

export { ACCESS_TTL, REFRESH_TTL };
