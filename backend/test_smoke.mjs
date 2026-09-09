// test_smoke.mjs —— 全链路冒烟测试（沙箱可直接跑，验证所有核心能力）
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.TRAVEL_DB = path.join(__dirname, 'travel.test.db');
process.env.PORT = '3999';
process.env.TRAVEL_SECRET = 'test-secret';

// 每次启动先清旧库，保证种子数据干净、避免 UNIQUE 冲突
try {
  fs.rmSync(process.env.TRAVEL_DB, { force: true });
  fs.rmSync(process.env.TRAVEL_DB + '-wal', { force: true });
  fs.rmSync(process.env.TRAVEL_DB + '-shm', { force: true });
} catch {}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('  ✅', name); pass++; }
  else { console.log('  ❌', name); fail++; }
}

await import('./server.js');
await new Promise((r) => setTimeout(r, 500)); // 等 listen

const BASE = 'http://localhost:3999';
async function call(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

console.log('\n== 1. 注册 / 登录 ==');
const reg = await call('POST', '/api/register', { nickname: '测试员', password: 'pw123' });
check('注册成功', reg.ok ?? reg.data.ok);
const login = await call('POST', '/api/login', { nickname: '测试员', password: 'pw123' });
check('登录拿到 accessToken', !!login.data.accessToken);
const token = login.data.accessToken;

console.log('\n== 2. 发帖（事务 + 优点标签）==');
const locs = await call('GET', '/api/locations');
const lid = locs.data.locations[0].id;
const post = await call('POST', '/api/posts', {
  locationId: lid, title: '测试帖', content: '测试内容', pricePerDay: 500, rating: 5, advantages: ['测试优点A', '测试优点B'],
}, token);
check('发帖成功', post.data.ok);
const pid = post.data.postId;

console.log('\n== 3. 投票 ==');
const v = await call('POST', `/api/posts/${pid}/vote`, { value: 1 }, token);
check('投票返回最新票数', typeof v.data.votes === 'number');

console.log('\n== 4. 聚合排行榜 ==');
const board = await call('GET', '/api/leaderboard');
check('榜单返回数组', Array.isArray(board.data.board) && board.data.board.length > 0);
check('榜单含热度字段', typeof board.data.board[0].heat === 'number');
check('榜单聚合了优点标签', board.data.board.some((l) => l.topAdvantages && l.topAdvantages.length > 0));

console.log('\n== 5. AI 总结（无 key 走规则兜底）==');
const sum = await call('POST', `/api/summarize/${lid}`);
check('总结返回文本', typeof sum.data.summary === 'string' && sum.data.summary.length > 0);
check('无 key 时为规则聚合', sum.data.source === 'rule' || sum.data.source === 'rule-fallback');

console.log('\n== 6. 行程规划 + 价格比较 ==');
const plan = await call('POST', '/api/plan', { destinations: [{ locationId: lid, days: 3 }], budget: 2000 });
check('规划返回路线', plan.data.ok && Array.isArray(plan.data.route));
check('规划含总花费', typeof plan.data.totalCost === 'number');
check('规划给预算建议', typeof plan.data.recommendation === 'string');
const price = await call('GET', `/api/price/${lid}`);
check('价格比较返回多条报价', price.data.quotes.length >= 1);

console.log('\n== 7. RBAC 管理员置顶 ==');
// 用普通用户 token 应被拒
const deny = await call('POST', `/api/admin/locations/${lid}/pin`, { pinned: 1 }, token);
check('非管理员不能置顶(403)', deny.status === 403);
// 用内置管理员登录
const adminLogin = await call('POST', '/api/login', { nickname: '平台管理员', password: 'admin123' });
const adminPin = await call('POST', `/api/admin/locations/${lid}/pin`, { pinned: 1 }, adminLogin.data.accessToken);
check('管理员可置顶', adminPin.data.ok);

console.log('\n== 8. 手机号 / 第三方登录 / 绑定 ==');
const phoneReg = await call('POST', '/api/auth/phone/register', { phone: '13800000000', password: 'pw123', nickname: '手机用户' });
check('手机号注册', phoneReg.data.ok);
const phoneLogin = await call('POST', '/api/auth/phone/login', { phone: '13800000000', password: 'pw123' });
check('手机号登录拿 token', !!phoneLogin.data.accessToken);
// 微信扫码：首次应要求先验证手机号或邮箱
const oauthFirst = await call('POST', '/api/auth/third/login', { provider: 'wechat', code: 'openid_test_001' });
check('微信扫码首次需验证', oauthFirst.data.needBind === true);
// 获取验证码（未配 SMTP 时为演示模式，回传 devCode）
const vcode = await call('POST', '/api/verify/send', { target: 'tester@example.com', scene: 'third_login' });
check('获取邮箱验证码', !!vcode.data.devCode);
// 错误验证码应被拒绝
const wrong = await call('POST', '/api/auth/third/login', { provider: 'wechat', code: 'openid_test_001', target: 'tester@example.com', verifyCode: '000000' });
check('错误验证码被拒绝', wrong.data.ok === false);
// 正确验证码 → 完成绑定并登录
const oauth = await call('POST', '/api/auth/third/login', { provider: 'wechat', code: 'openid_test_001', target: 'tester@example.com', verifyCode: vcode.data.devCode });
check('验证后微信登录成功', !!oauth.data.accessToken);
// 再次扫码 → 已绑定，直接登录
const oauthAgain = await call('POST', '/api/auth/third/login', { provider: 'wechat', code: 'openid_test_001' });
check('再次扫码直接登录', oauthAgain.data.ok === true);
// 已登录用户绑定邮箱（需验证码）
const emailCode = await call('POST', '/api/verify/send', { target: 'bind@example.com', scene: 'bind' });
const bindEmail = await call('POST', '/api/auth/contact/bind', { target: 'bind@example.com', verifyCode: emailCode.data.devCode }, token);
check('绑定邮箱（验证码）', bindEmail.data.ok === true);
// 非法地址应报错
const badTarget = await call('POST', '/api/verify/send', { target: '不是邮箱也不是手机', scene: 'bind' });
check('非法手机号/邮箱被拒绝', badTarget.data.ok === false);
const bind = await call('POST', '/api/auth/bind', { provider: 'qq', externalId: 'qq_openid_001' }, token);
check('绑定 QQ 账号', bind.data.ok);

console.log('\n== 9. AI 旅行助手（规则兜底）==');
const chat = await call('POST', '/api/chat', { messages: [{ role: 'user', content: '帮我规划三亚和成都的5日游' }] }, token);
check('AI 助手返回回复', typeof chat.data.reply === 'string' && chat.data.reply.length > 0);

console.log('\n== 10. 社区评论 + 运维监控 ==');
const cm = await call('POST', `/api/posts/${pid}/comments`, { content: '测试评论' }, token);
check('发评论', cm.data.ok);
const cmlist = await call('GET', `/api/posts/${pid}/comments`);
check('读评论列表', cmlist.data.comments.length > 0);
const health = await call('GET', '/api/health');
check('健康检查', health.data.ok && typeof health.data.uptimeSec === 'number');
const ops = await call('GET', '/api/admin/ops', undefined, adminLogin.data.accessToken);
check('管理员运维看板', ops.data.ok && !!ops.data.stats.counts);

console.log(`\n==== 结果：通过 ${pass} / 失败 ${fail} ====`);
// 清理测试库
try { fs.rmSync(process.env.TRAVEL_DB, { force: true }); fs.rmSync(process.env.TRAVEL_DB + '-wal', { force: true }); fs.rmSync(process.env.TRAVEL_DB + '-shm', { force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
