// 公网版 handler 接线测试：聚合权重/preview/规划/规则助手/路由边界。
// 本地完整版 79 条断言不受影响（test_agent_react/test_smoke/test_tc3_signature）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTravel } from '../playground/functions/handler.mjs';

const env = () => undefined;
const get = (t) => handleTravel({ request: new Request(`http://local/functions/v1/app/${t}`), supabase: null, env });
const post = (t, b) => handleTravel({ request: new Request(`http://local/functions/v1/app/${t}`, { method: 'POST', body: JSON.stringify(b) }), supabase: null, env });

test('leaderboard 权重与本地 aggregator 同源', async () => {
  const j = await (await get('leaderboard')).json();
  assert.equal(j.ok, true);
  const sanya = j.board.find((l) => l.name === '三亚');
  assert.equal(sanya.heat, 32.5); // 2帖*2 + 2票*3 + 4.5分*5
  assert.equal(sanya.postCount, 2);
  assert.ok(sanya.topAdvantages.some((a) => a.name === '海水清澈' && a.freq === 1));
  assert.equal(j.board.length, 6);
});

test('preview 成都并入后热度数值', async () => {
  const base = await (await get('leaderboard')).json();
  const loc = base.board.find((l) => l.name === '成都');
  const j = await (await post('preview', { extraPosts: [{ locationId: loc.id, title: 't', content: 'c', rating: 5, advantages: [], votes: 3 }] })).json();
  const cd = j.board.find((l) => l.name === '成都');
  // 3帖*2 + (2+3)票*3 + ((5+4+5)/3)*5 = 6 + 15 + 23.333… = 44.3
  assert.equal(cd.heat, 44.3);
});

test('preview 非法输入 400', async () => {
  const r = await post('preview', { extraPosts: [{ locationId: 'not-uuid', title: 't', content: 'c' }] });
  assert.equal(r.status, 400);
});

test('plan 路线与预算建议', async () => {
  const { locations } = await (await get('locations')).json();
  const ids = locations.slice(0, 2).map((l) => ({ locationId: l.id, days: 3 }));
  const j = await (await post('plan', { destinations: ids, budget: 100 })).json();
  assert.equal(j.ok, true);
  assert.equal(j.route.length, 2);
  assert.match(j.recommendation, /不足/);
});

test('chat 无 Key 走规则兜底', async () => {
  const j = await (await post('chat', { messages: [{ role: 'user', content: '帮我规划三亚+成都5日游' }] })).json();
  assert.equal(j.source, 'rule');
  assert.match(j.reply, /路线/);
});

test('summarize 规则版不编造', async () => {
  const { locations } = await (await get('locations')).json();
  const j = await (await post('summarize', { locationId: locations[0].id })).json();
  assert.equal(j.source, 'rule');
  assert.match(j.summary, /三亚/);
});

test('comments 种子可读；未知路由 404；GET 写路由 405', async () => {
  const c = await (await get('comments?postId=00000000-0000-4000-8000-000000000101')).json();
  assert.equal(c.comments.length, 2);
  assert.equal((await post('nope', {})).status, 404);
  assert.equal((await get('preview')).status, 405);
});