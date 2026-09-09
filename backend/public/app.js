// app.js —— 前端逻辑（原生 JS，调用 /api）
const API = '';
let auth = JSON.parse(localStorage.getItem('travel_auth') || 'null');

async function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (auth?.accessToken) opts.headers.Authorization = `Bearer ${auth.accessToken}`;
  if (opts.body && !(opts.body instanceof FormData)) opts.headers['Content-Type'] = 'application/json';
  let res = await fetch(API + path, opts);
  if (res.status === 401 && auth?.refreshToken) {
    const r = await fetch(API + '/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: auth.refreshToken }) });
    if (r.ok) { const d = await r.json(); auth.accessToken = d.accessToken; auth.user = d.user; localStorage.setItem('travel_auth', JSON.stringify(auth)); return api(path, opts); }
    else { auth = null; localStorage.removeItem('travel_auth'); }
  }
  return res;
}

/* ---------- 顶部 / 登录 ---------- */
function renderUser() {
  const box = document.getElementById('userBox');
  if (auth?.user) {
    box.innerHTML = `<button class="me-btn" id="meBtn">${auth.user.avatar} ${auth.user.nickname}<span class="badge-dot hidden" id="unreadDot"></span></button>
      <button class="btn ghost" id="logoutBtn">退出</button>`;
    document.getElementById('logoutBtn').onclick = () => { auth = null; localStorage.removeItem('travel_auth'); renderUser(); };
    document.getElementById('meBtn').onclick = openMe;
    if (auth.user.role === 'admin') document.getElementById('opsTab').style.display = '';
    refreshUnread();
  } else {
    box.innerHTML = `<button class="btn ghost" id="loginBtn">登录 / 注册</button>`;
    document.getElementById('loginBtn').onclick = () => document.getElementById('loginModal').classList.remove('hidden');
    document.getElementById('opsTab').style.display = 'none';
  }
}
function hideLogin() {
  document.getElementById('loginModal').classList.add('hidden');
  document.getElementById('bindStep').classList.add('hidden');
}
document.getElementById('loginModal').addEventListener('click', (e) => { if (e.target.id === 'loginModal') hideLogin(); });
document.getElementById('closeModal').onclick = hideLogin;

async function doLogin(registerMode) {
  const nickname = document.getElementById('lgnNick').value.trim();
  const password = document.getElementById('lgnPwd').value;
  const msg = document.getElementById('lgnMsg');
  if (!nickname || !password) { msg.textContent = '请填写昵称和密码'; msg.className = 'msg err'; return; }
  const path = registerMode ? '/api/register' : '/api/login';
  const res = await api(path, { method: 'POST', body: JSON.stringify({ nickname, password }) });
  const d = await res.json();
  if (!d.ok) { msg.textContent = d.error; msg.className = 'msg err'; return; }
  if (!registerMode) {
    auth = { accessToken: d.accessToken, refreshToken: d.refreshToken, user: d.user };
    localStorage.setItem('travel_auth', JSON.stringify(auth));
  }
  msg.textContent = registerMode ? '注册成功，请登录' : '登录成功';
  msg.className = 'msg ok';
  renderUser();
  setTimeout(() => document.getElementById('loginModal').classList.add('hidden'), 600);
  loadLocations();
}
document.getElementById('lgnSubmit').onclick = () => doLogin(false);
document.getElementById('lgnRegister').onclick = () => doLogin(true);
document.querySelectorAll('.chip').forEach((c) => c.onclick = () => { document.getElementById('lgnNick').value = c.dataset.u; document.getElementById('lgnPwd').value = c.dataset.p; });

/* ---------- Tab 切换 ---------- */
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('panel-' + t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 'community') loadCommunity();
  if (t.dataset.tab === 'ops') loadOps();
});

/* ---------- 口碑榜 ---------- */
async function loadBoard() {
  const res = await api('/api/leaderboard');
  const d = await res.json();
  const list = document.getElementById('boardList');
  list.innerHTML = '';
  d.board.forEach((loc, i) => {
    const advs = loc.topAdvantages.map((a) => `<span class="tag">${a.name} ×${a.freq}</span>`).join('');
    const hot = loc.hotPosts.map((p) => `<div class="hot-post"><b>👍${p.votes}</b> ${p.title}</div>`).join('');
    const card = document.createElement('div');
    card.className = 'loc-card';
    card.innerHTML = `
      <div class="rank">#${i + 1} ${loc.pinned ? '📌 置顶' : ''}</div>
      <div class="loc-name">${loc.name}</div>
      <div class="loc-meta">${loc.city} · ${loc.category} · ${loc.postCount} 篇分享</div>
      <div class="heat">🔥 热度 ${loc.heat}</div>
      <div class="tags">${advs || '<span class="tag">暂无优点标签</span>'}</div>
      <div class="hot-posts">${hot}</div>
      <button class="btn ghost" data-sum="${loc.id}" style="margin-top:10px">✨ 让平台 AI 总结优点</button>
      <div class="summary hidden" data-sumbox="${loc.id}"></div>`;
    list.appendChild(card);
  });
  list.querySelectorAll('[data-sum]').forEach((b) => b.onclick = () => summarize(b.dataset.sum, b));
}
async function summarize(id, btn) {
  btn.disabled = true; btn.textContent = '总结中…';
  const res = await api('/api/summarize/' + id, { method: 'POST' });
  const d = await res.json();
  const box = document.querySelector(`[data-sumbox="${id}"]`);
  const badge = d.source === 'llm' ? '<span class="badge llm">大模型</span>' : '<span class="badge rule">规则聚合</span>';
  box.innerHTML = `📋 ${d.summary} ${badge}`;
  box.classList.remove('hidden');
  btn.textContent = '✨ 重新总结';
  btn.disabled = false;
}

/* ---------- 地点下拉 ---------- */
async function loadLocations() {
  const res = await api('/api/locations');
  const d = await res.json();
  const sel = document.getElementById('postLocation');
  const plan = document.getElementById('planDestinations');
  const price = document.getElementById('priceLocation');
  sel.innerHTML = d.locations.map((l) => `<option value="${l.id}">${l.name}（${l.city}）</option>`).join('');
  price.innerHTML = sel.innerHTML;
  plan.innerHTML = d.locations.map((l) => `
    <label class="dest"><input type="checkbox" value="${l.id}" /> ${l.name}
      <input type="number" min="1" value="3" data-days="${l.id}" /> 天</label>`).join('');
}

/* ---------- 发帖 ---------- */
document.getElementById('postForm').onsubmit = async (e) => {
  e.preventDefault();
  const msg = document.getElementById('postMsg');
  if (!auth?.user) { msg.textContent = '请先登录'; msg.className = 'msg err'; document.getElementById('loginModal').classList.remove('hidden'); return; }
  const body = {
    locationId: Number(document.getElementById('postLocation').value),
    title: document.getElementById('postTitle').value,
    content: document.getElementById('postContent').value,
    pricePerDay: document.getElementById('postPrice').value ? Number(document.getElementById('postPrice').value) : null,
    rating: Number(document.getElementById('postRating').value),
    advantages: document.getElementById('postAdvantages').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  };
  const res = await api('/api/posts', { method: 'POST', body: JSON.stringify(body) });
  const d = await res.json();
  if (d.ok) { msg.textContent = '发布成功！已加入口碑榜'; msg.className = 'msg ok'; e.target.reset(); loadBoard(); }
  else { msg.textContent = d.error; msg.className = 'msg err'; }
};

/* ---------- 行程规划 ---------- */
document.getElementById('planBtn').onclick = async () => {
  const checks = [...document.querySelectorAll('#planDestinations input[type=checkbox]:checked')];
  if (checks.length === 0) { alert('请至少勾选一个目的地'); return; }
  const destinations = checks.map((c) => ({ locationId: Number(c.value), days: Number(document.querySelector(`[data-days="${c.value}"]`).value) || 3 }));
  const budget = document.getElementById('planBudget').value ? Number(document.getElementById('planBudget').value) : null;
  const res = await api('/api/plan', { method: 'POST', body: JSON.stringify({ destinations, budget }) });
  const d = await res.json();
  const box = document.getElementById('planResult');
  if (!d.ok) { box.innerHTML = `<p class="msg err">${d.error}</p>`; return; }
  const steps = d.stops.map((s, i) => `
    <div class="route-step">
      <h4>第 ${i + 1} 站 · ${s.name}（${s.city}）</h4>
      <div>建议天数：${s.days} 天 · 推荐方案：<b>${s.chosenProvider}</b> ¥${s.chosenPrice} → 预估 ¥${s.estCost}</div>
      <table class="cmp"><tr><th>套餐/方式</th><th>价格</th><th>天数</th></tr>
      ${s.comparison.map((q) => `<tr><td>${q.provider}</td><td>¥${q.price}</td><td>${q.duration_days}天</td></tr>`).join('')}</table>
    </div>`).join('');
  box.innerHTML = `<h3>推荐路线：${d.route.join(' → ')}</h3>${steps}
    <div class="reco">💡 ${d.recommendation}（预计总花费 ¥${d.totalCost}）</div>`;
};

/* ---------- 价格比较 ---------- */
document.getElementById('priceBtn').onclick = async () => {
  const id = document.getElementById('priceLocation').value;
  const res = await api('/api/price/' + id);
  const d = await res.json();
  const box = document.getElementById('priceResult');
  if (!d.quotes.length) { box.innerHTML = '<p>暂无报价</p>'; return; }
  box.innerHTML = `<table class="cmp"><tr><th>套餐/方式</th><th>价格</th><th>天数</th></tr>
    ${d.quotes.map((q) => `<tr><td>${q.provider}</td><td>¥${q.price}</td><td>${q.duration_days}天</td></tr>`).join('')}</table>
    <p class="msg ok">最低价：${d.quotes[0].provider} ¥${d.quotes[0].price}</p>`;
};

/* ---------- AI 助手对话 ---------- */
let chatMsgs = [];
async function sendChat() {
  const text = document.getElementById('chatText').value.trim();
  if (!text) return;
  if (!auth?.user) { alert('请先登录'); return; }
  chatMsgs.push({ role: 'user', content: text });
  renderChat();
  document.getElementById('chatText').value = '';
  const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: chatMsgs }) });
  const d = await res.json();
  chatMsgs.push({ role: 'assistant', content: d.reply });
  renderChat();
}
function renderChat() {
  const box = document.getElementById('chatBox');
  box.innerHTML = chatMsgs.map((m) =>
    `<div class="bubble ${m.role}">${m.role === 'user' ? '🧑' : '🤖'} ${m.content}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}
document.getElementById('chatSend').onclick = sendChat;
document.getElementById('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

/* ---------- 社区动态 + 评论 ---------- */
async function loadCommunity() {
  const res = await api('/api/posts');
  const d = await res.json();
  const list = document.getElementById('communityList');
  list.innerHTML = '';
  for (const p of d.posts) {
    const cRes = await api('/api/posts/' + p.id + '/comments');
    const c = await cRes.json();
    const card = document.createElement('div');
    card.className = 'loc-card';
    card.innerHTML = `
      <div class="loc-name">${escapeHtml(p.title)}</div>
      <div class="loc-meta">${p.location || p.location_name || ''} · 👍${p.votes || 0} · 作者 ${p.author_avatar || '🧳'} ${escapeHtml(p.author || '匿名')}</div>
      <div style="font-size:13px;margin:6px 0">${escapeHtml(p.content)}</div>
      <div class="tags">${(p.advantages || []).map((a) => `<span class="tag">${escapeHtml(a)}</span>`).join('')}</div>
      <div class="hot-posts"><b>评论 ${c.comments.length} 条</b>
        ${c.comments.map((x) => `<div class="hot-post">${x.avatar} <b>${escapeHtml(x.author)}</b>：${escapeHtml(x.content)}</div>`).join('')}
      </div>
      <input id="cmt-${p.id}" placeholder="写下评论…（作者会收到通知）" style="width:70%;padding:6px;margin-top:6px" />
      <button class="btn ghost" data-cmt="${p.id}">评论</button>
      ${p.user_id && p.user_id !== auth?.user?.id ? `<button class="btn ghost" data-ask="${p.user_id}">✉️ 问作者</button>` : ''}`;
    list.appendChild(card);
  }
  list.querySelectorAll('[data-cmt]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.cmt;
    const content = document.getElementById('cmt-' + id).value.trim();
    if (!content) return;
    if (!auth?.user) { alert('请先登录'); return; }
    await api('/api/posts/' + id + '/comments', { method: 'POST', body: JSON.stringify({ content }) });
    loadCommunity();
  });
  list.querySelectorAll('[data-ask]').forEach((b) => b.onclick = () => askAuthor(Number(b.dataset.ask)));
}

/* ---------- 账号绑定 ---------- */
document.getElementById('closeBind').onclick = () => document.getElementById('bindModal').classList.add('hidden');
document.getElementById('bindModal').addEventListener('click', (e) => { if (e.target.id === 'bindModal') e.target.classList.add('hidden'); });
document.getElementById('bindPhoneBtn').onclick = async () => {
  const phone = document.getElementById('bindPhone').value.trim();
  const pwd = document.getElementById('bindPhonePwd').value;
  const msg = document.getElementById('bindMsg');
  if (!auth?.user) { msg.textContent = '请先登录'; msg.className = 'msg err'; return; }
  const res = await api('/api/auth/phone/register', { method: 'POST', body: JSON.stringify({ phone, password: pwd, nickname: auth.user.nickname }) });
  const d = await res.json();
  if (!d.ok) { msg.textContent = d.error; msg.className = 'msg err'; return; }
  // 注册后把当前账号与该手机号绑定
  await api('/api/auth/bind', { method: 'POST', body: JSON.stringify({ provider: 'phone', externalId: phone }) });
  msg.textContent = '手机号绑定成功'; msg.className = 'msg ok';
};
document.getElementById('bindWechat').onclick = async () => {
  const msg = document.getElementById('bindMsg');
  if (!auth?.user) { msg.textContent = '请先登录'; msg.className = 'msg err'; return; }
  const r = await api('/api/auth/bind', { method: 'POST', body: JSON.stringify({ provider: 'wechat', externalId: 'wx_' + Date.now() }) });
  msg.textContent = r.ok ? '微信绑定成功（mock）' : (r.error || '失败'); msg.className = r.ok ? 'msg ok' : 'msg err';
};
document.getElementById('bindQQ').onclick = async () => {
  const msg = document.getElementById('bindMsg');
  if (!auth?.user) { msg.textContent = '请先登录'; msg.className = 'msg err'; return; }
  const r = await api('/api/auth/bind', { method: 'POST', body: JSON.stringify({ provider: 'qq', externalId: 'qq_' + Date.now() }) });
  msg.textContent = r.ok ? 'QQ 绑定成功（mock）' : (r.error || '失败'); msg.className = r.ok ? 'msg ok' : 'msg err';
};

/* ---------- 运维看板 ---------- */
async function loadOps() {
  const res = await api('/api/admin/ops');
  const d = await res.json();
  const box = document.getElementById('opsBox');
  if (!d.ok) { box.innerHTML = '<p>无权限</p>'; return; }
  const s = d.stats;
  box.innerHTML = `<div class="reco">⏱ 运行时长：${d.uptimeSec}s</div>
    <table class="cmp"><tr><th>数据表</th><th>记录数</th></tr>
    ${Object.entries(s.counts).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
    <p class="msg ok">最近活跃：${s.lastActivity || '无'} ｜ 最热地点：${s.hottestLocation ? s.hottestLocation.name + '（' + s.hottestLocation.c + '帖）' : '无'}</p>`;
}

/* ---------- 桌宠 AI 助手 ---------- */
let petMsgs = [];
const deskPet = document.getElementById('deskPet');
const petChat = document.getElementById('petChat');
const petChatBox = document.getElementById('petChatBox');
const petChatText = document.getElementById('petChatText');
const petChatSend = document.getElementById('petChatSend');
const petChatClose = document.getElementById('petChatClose');

function renderPetChat() {
  petChatBox.innerHTML = petMsgs.map((m) =>
    `<div class="bubble ${m.role}">${m.role === 'user' ? '🧑' : '🐷'} ${escapeHtml(m.content)}</div>`).join('');
  petChatBox.scrollTop = petChatBox.scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendPetChat() {
  const text = petChatText.value.trim();
  if (!text) return;
  if (!auth?.user) {
    petMsgs.push({ role: 'assistant', content: '先登录一下嘛，这样我才能记住你的偏好～' });
    renderPetChat();
    document.getElementById('loginModal').classList.remove('hidden');
    return;
  }
  petMsgs.push({ role: 'user', content: text });
  renderPetChat();
  petChatText.value = '';
  petChatSend.textContent = '...';
  petChatSend.disabled = true;
  const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: petMsgs }) });
  const d = await res.json();
  petMsgs.push({ role: 'assistant', content: d.reply });
  renderPetChat();
  petChatSend.textContent = '发送';
  petChatSend.disabled = false;
}

deskPet.onclick = () => {
  if (petMsgs.length === 0) {
    petMsgs.push({ role: 'assistant', content: '嗨！我是猪猪旅行助手～问我去哪玩、怎么规划最划算，我帮你查路线和比价 🐹' });
    renderPetChat();
  }
  petChat.classList.toggle('hidden');
};
petChatClose.onclick = (e) => { e.stopPropagation(); petChat.classList.add('hidden'); };
petChatSend.onclick = sendPetChat;
petChatText.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendPetChat(); });
document.querySelectorAll('.pet-quick button').forEach((b) => b.onclick = () => { petChatText.value = b.dataset.q; sendPetChat(); });

/* ---------- 我的：个人中心 + 消息中心 ---------- */
const meDrawer = document.getElementById('meDrawer');
let currentThreadUser = null;

function openMe() {
  if (!auth?.user) { document.getElementById('loginModal').classList.remove('hidden'); return; }
  meDrawer.classList.remove('hidden');
  loadMe();
}
function closeMe() { meDrawer.classList.add('hidden'); }
document.getElementById('meClose').onclick = closeMe;
document.getElementById('meMask').onclick = closeMe;

async function loadMe() {
  const res = await api('/api/me');
  const d = await res.json();
  if (!d.ok) return;
  const p = d.profile;
  if (p) {
    document.getElementById('meProfile').innerHTML = `
      <div class="me-avatar">${p.avatar}</div>
      <div class="me-info">
        <div class="me-name">${escapeHtml(p.nickname)} ${p.role === 'admin' ? '<span class="tag">管理员</span>' : ''}</div>
        <div class="me-stats">📝 帖子 ${p.stats.posts} ｜ 💬 评论 ${p.stats.comments} ｜ 👍 获赞 ${p.stats.likes}</div>
      </div>`;
  }
  loadMyPosts();
  loadNotifications();
  loadConversations();
  loadBindList();
  refreshUnread(d.unread);
}

async function refreshUnread(u) {
  try {
    const unread = u || (await (await api('/api/unread')).json()).unread;
    const total = (unread && unread.total) || 0;
    const dot = document.getElementById('unreadDot');
    const mdot = document.getElementById('meMsgDot');
    if (dot) dot.classList.toggle('hidden', !total);
    if (mdot) { mdot.classList.toggle('hidden', !total); mdot.textContent = total > 99 ? '99+' : total; }
  } catch { /* 未登录时忽略 */ }
}

async function loadMyPosts() {
  const res = await api('/api/users/' + auth.user.id);
  const d = await res.json();
  const box = document.getElementById('mePanePosts');
  if (!d.posts || !d.posts.length) { box.innerHTML = '<p class="sub">还没有发帖，去「发帖分享」写一篇吧～</p>'; return; }
  box.innerHTML = d.posts.map((p) =>
    `<div class="me-post">📝 ${escapeHtml(p.title)}<span class="me-time">${p.created_at || ''}</span></div>`).join('');
}

async function loadNotifications() {
  const res = await api('/api/notifications');
  const d = await res.json();
  const box = document.getElementById('notifyPane');
  const list = d.notifications || [];
  if (!list.length) { box.innerHTML = '<p class="sub">暂无通知</p>'; return; }
  box.innerHTML = `<button class="btn ghost" id="readAllNtf">全部标为已读</button>` +
    list.map((n) => `<div class="ntf ${n.is_read ? '' : 'unread'}">${n.is_read ? '🔔' : '🔴'} ${escapeHtml(n.content)}<span class="me-time">${n.created_at || ''}</span></div>`).join('');
  document.getElementById('readAllNtf').onclick = async () => {
    await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({}) });
    loadNotifications();
    refreshUnread();
  };
}

async function loadConversations() {
  const res = await api('/api/messages/conversations');
  const d = await res.json();
  const box = document.getElementById('convList');
  const list = d.conversations || [];
  if (!list.length) { box.innerHTML = '<p class="sub">还没有私信。在社区帖子下点「✉️ 问作者」就能聊～</p>'; return; }
  box.innerHTML = list.map((c) => `
    <div class="conv" data-uid="${c.user_id}">
      <span class="conv-avatar">${c.avatar}</span>
      <div class="conv-main">
        <div class="conv-name">${escapeHtml(c.nickname)} ${c.unread ? `<span class="badge-dot">${c.unread}</span>` : ''}</div>
        <div class="conv-last">${escapeHtml(c.last_content || '')}</div>
      </div>
    </div>`).join('');
  box.querySelectorAll('.conv').forEach((el) => el.onclick = () => openThread(Number(el.dataset.uid)));
}

async function openThread(uid) {
  currentThreadUser = uid;
  const res = await api('/api/messages/thread/' + uid);
  const d = await res.json();
  document.getElementById('convList').classList.add('hidden');
  document.getElementById('threadView').classList.remove('hidden');
  document.getElementById('threadWho').textContent = `${d.other?.avatar || '🧳'} ${d.other?.nickname || ''}`;
  const box = document.getElementById('threadMsgs');
  box.innerHTML = (d.messages || []).map((m) =>
    `<div class="bubble ${m.from_user === auth.user.id ? 'user' : 'assistant'}">${escapeHtml(m.content)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
  loadConversations();
  refreshUnread();
}
document.getElementById('backConv').onclick = () => {
  currentThreadUser = null;
  document.getElementById('threadView').classList.add('hidden');
  document.getElementById('convList').classList.remove('hidden');
  loadConversations();
};
async function sendThread() {
  const input = document.getElementById('threadText');
  const content = input.value.trim();
  if (!content || !currentThreadUser) return;
  input.value = '';
  await api('/api/messages', { method: 'POST', body: JSON.stringify({ toUserId: currentThreadUser, content }) });
  openThread(currentThreadUser);
}
document.getElementById('threadSend').onclick = sendThread;
document.getElementById('threadText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendThread(); });

// 从帖子点「问作者」直接发起私信
function askAuthor(uid) {
  if (!auth?.user) { document.getElementById('loginModal').classList.remove('hidden'); return; }
  openMe();
  document.querySelector('.me-tab[data-mt="msg"]')?.click();
  document.querySelector('.msg-tab[data-ct="chat"]')?.click();
  openThread(uid);
}

/* ---------- 验证码 / 第三方扫码登录 / 账号绑定 ---------- */
let thirdPending = null; // 记录当前扫码的 { provider, code }

// 微信 / QQ 扫码登录：已绑定直接进，首次要求验证手机号或邮箱
async function startThirdLogin(provider) {
  // 真实环境此处唤起扫码；演示模式生成一次性 code 模拟扫码结果
  const code = (provider === 'wechat' ? 'wx_' : 'qq_') + Math.random().toString(36).slice(2, 10);
  thirdPending = { provider, code };
  const res = await api('/api/auth/third/login', { method: 'POST', body: JSON.stringify({ provider, code }) });
  const d = await res.json();
  if (d.ok) {
    auth = { accessToken: d.accessToken, refreshToken: d.refreshToken, user: d.user };
    localStorage.setItem('travel_auth', JSON.stringify(auth));
    renderUser();
    document.getElementById('loginModal').classList.add('hidden');
    return;
  }
  document.getElementById('bindProviderName').textContent = provider === 'wechat' ? '微信' : 'QQ';
  document.getElementById('bindStep').classList.remove('hidden');
  const msg = document.getElementById('lgnMsg');
  msg.textContent = d.error || '请绑定手机号或邮箱';
  msg.className = 'msg err';
}
document.getElementById('wxLogin').onclick = () => startThirdLogin('wechat');
document.getElementById('qqLogin').onclick = () => startThirdLogin('qq');

// 第三方登录流程：获取验证码
document.getElementById('bindSendCode').onclick = async () => {
  const target = document.getElementById('bindTarget').value.trim();
  const msg = document.getElementById('lgnMsg');
  if (!target) { msg.textContent = '请输入手机号或邮箱'; msg.className = 'msg err'; return; }
  const r = await api('/api/verify/send', { method: 'POST', body: JSON.stringify({ target, scene: 'third_login' }) });
  const d = await r.json();
  if (!d.ok) { msg.textContent = d.error; msg.className = 'msg err'; return; }
  msg.textContent = d.delivered
    ? `验证码已发送到 ${target}，5 分钟内有效`
    : `演示模式：验证码已发往 ${target}（服务端控制台可查），你的验证码是 ${d.devCode}`;
  msg.className = 'msg ok';
};
// 第三方登录流程：验证并登录
document.getElementById('bindConfirm').onclick = async () => {
  const msg = document.getElementById('lgnMsg');
  if (!thirdPending) { msg.textContent = '请重新扫码'; msg.className = 'msg err'; return; }
  const target = document.getElementById('bindTarget').value.trim();
  const verifyCode = document.getElementById('bindCode').value.trim();
  if (!target || !verifyCode) { msg.textContent = '请填写手机号/邮箱与验证码'; msg.className = 'msg err'; return; }
  const r = await api('/api/auth/third/login', {
    method: 'POST',
    body: JSON.stringify({ provider: thirdPending.provider, code: thirdPending.code, target, verifyCode }),
  });
  const d = await r.json();
  if (!d.ok) { msg.textContent = d.error; msg.className = 'msg err'; return; }
  auth = { accessToken: d.accessToken, refreshToken: d.refreshToken, user: d.user };
  localStorage.setItem('travel_auth', JSON.stringify(auth));
  renderUser();
  document.getElementById('bindStep').classList.add('hidden');
  document.getElementById('loginModal').classList.add('hidden');
  msg.textContent = '验证通过，已绑定并登录';
  msg.className = 'msg ok';
};

/* ---------- 抽屉内账号绑定（手机号/邮箱需验证码）---------- */
async function loadBindList() {
  const res = await api('/api/auth/me/identities');
  const d = await res.json();
  const box = document.getElementById('bindList');
  const list = d.identities || [];
  if (!list.length) { box.innerHTML = '<p class="sub">尚未绑定任何登录方式</p>'; return; }
  const nameMap = { phone: '📱 手机号', email: '📧 邮箱', wechat: '💬 微信', qq: '🐧 QQ' };
  box.innerHTML = list.map((i) =>
    `<div class="bind-item">${nameMap[i.provider] || i.provider}：${escapeHtml(i.external_id)}</div>`).join('');
}
document.getElementById('meBindSendCode').onclick = async () => {
  const target = document.getElementById('meBindTarget').value.trim();
  const msg = document.getElementById('meBindMsg');
  if (!target) { msg.textContent = '请输入手机号或邮箱'; msg.className = 'msg err'; return; }
  const r = await api('/api/verify/send', { method: 'POST', body: JSON.stringify({ target, scene: 'bind' }) });
  const d = await r.json();
  if (!d.ok) { msg.textContent = d.error; msg.className = 'msg err'; return; }
  msg.textContent = d.delivered ? `验证码已发送到 ${target}` : `演示模式：你的验证码是 ${d.devCode}`;
  msg.className = 'msg ok';
};
document.getElementById('meBindBtn').onclick = async () => {
  const target = document.getElementById('meBindTarget').value.trim();
  const verifyCode = document.getElementById('meBindCode').value.trim();
  const msg = document.getElementById('meBindMsg');
  if (!target || !verifyCode) { msg.textContent = '请填写手机号/邮箱与验证码'; msg.className = 'msg err'; return; }
  const r = await api('/api/auth/contact/bind', { method: 'POST', body: JSON.stringify({ target, verifyCode }) });
  const d = await r.json();
  msg.textContent = d.ok ? '绑定成功' : d.error;
  msg.className = d.ok ? 'msg ok' : 'msg err';
  if (d.ok) {
    document.getElementById('meBindTarget').value = '';
    document.getElementById('meBindCode').value = '';
    loadBindList();
  }
};
document.getElementById('meBindWx').onclick = async () => {
  const msg = document.getElementById('meBindMsg');
  const r = await api('/api/auth/bind', { method: 'POST', body: JSON.stringify({ provider: 'wechat', externalId: 'wx_' + Date.now() }) });
  msg.textContent = r.ok ? '微信绑定成功' : '绑定失败'; msg.className = r.ok ? 'msg ok' : 'msg err';
  if (r.ok) loadBindList();
};
document.getElementById('meBindQQ').onclick = async () => {
  const msg = document.getElementById('meBindMsg');
  const r = await api('/api/auth/bind', { method: 'POST', body: JSON.stringify({ provider: 'qq', externalId: 'qq_' + Date.now() }) });
  msg.textContent = r.ok ? 'QQ 绑定成功' : '绑定失败'; msg.className = r.ok ? 'msg ok' : 'msg err';
  if (r.ok) loadBindList();
};

/* ---------- 启动 ---------- */
renderUser();
loadBoard();
loadLocations();
