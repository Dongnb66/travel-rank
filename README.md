# 🧭 途见 TravelRank · 旅游口碑聚合与行程规划平台

一个**用户发帖分享地点优点 → 平台自动聚合口碑榜 → AI 总结 + 行程规划比价**的全栈项目。
与"多智能体 / RAG"类 AI 项目互补，独立展示**前后端工程 + 数据聚合排名**能力。

> 技术栈：Node.js 22（Express + 内置 `node:sqlite`，**零原生依赖**）· 原生 JS 单页前端
> 一条命令 `node --experimental-sqlite server.js` 即可启动，无需 `npm install` 任何原生模块。

## 核心功能

1. **用户发帖分享**：选择地点，写标题/内容/日均花费/评分，打"优点标签"（如「海水清澈」「火锅好吃」）。
2. **平台聚合口碑榜**（项目灵魂）：把所有零散帖子用 SQL 聚合为「地点口碑总榜」
   - 热度 = 发帖数 × 2 + 投票 × 3 + 平均评分 × 5
   - 自动提炼各地**被反复提到的高频优点**（`GROUP BY advantage` + 频次排序）
   - 各地点热门帖同步上榜
3. **AI 口碑总结**：调用大模型把某地点多篇帖子凝练成一句话总结
   - 有 `TRAVEL_LLM_KEY` 走 DeepSeek；无 Key 自动回退**规则聚合**，绝不凭空编造（防幻觉）
4. **行程规划 + 价格比较**：勾选目的地与天数 → 自动排路线（同城集中、按性价比排序）、拉多套餐报价比价、给预算建议。
5. **账号体系（多方式登录 / 绑定 / 验证码）**：
   - 账号密码、手机号+密码注册登录
   - **微信 / QQ 扫码登录**：已绑定直接进；**首次登录强制先验证手机号或邮箱 + 验证码**，避免产生无法找回的僵尸账号
   - **验证码双通道**：手机号走**腾讯云短信 SMS**，邮箱走 **SMTP**（未配置自动降级为演示模式，验证码回传前端便于联调）
   - 个人主页「我的」抽屉：资料、统计、我的帖子、消息中心（私信 + 通知）、账号绑定
6. **消息中心**：私信会话 + 评论自动通知作者，顶栏「我的」带未读红点
6. **AI 旅行助手（智能体 + 工具调用）**：对话式规划，智能体可调用工具——`list_locations` / `get_price` / `optimize_route` / `baidu_map_search`（百度地图搜宝藏地点，有 AK 走真实 API，否则 mock 兜底）；有 Key 走 DeepSeek 函数调用，无 Key 走规则。
7. **社区**：帖子评论互动，社区动态流。
8. **运营维护**：结构化请求日志（方法/路径/状态码/耗时）、`/api/health` 健康检查、`/api/admin/ops` 运维看板（数据规模与运行时长），体现上线后的可观测性。

## 工程亮点（简历可写）

- **JWT 双令牌 + RBAC**：用 Node 原生 `crypto`（HMAC-SHA256 + scrypt）实现 access/refresh 双 token 与角色权限，**零鉴权第三方依赖**
- **多方式登录 / 账号绑定**：手机号+密码注册登录 + 微信/QQ 扫码登录（首次强制验证码绑定），同一用户可绑多身份（覆盖社招高频 JD 词）
- **腾讯云短信（零依赖对接）**：用 Node 内置 `crypto` 自行实现腾讯云 API 3.0 的 **TC3-HMAC-SHA256 签名**（不引 SDK），配 5 个环境变量即真实下发；`SMS_DRY_RUN=1` 可只看请求体不扣费
- **签名算法有测试背书**：`test_tc3_signature.mjs` 用腾讯云官方文档公开的测试向量校验（payload 哈希 + HashedCanonicalRequest + 最终 Signature），**14/14 通过**
- **AI 智能体 + 工具调用**：`/api/chat` 旅行助手以 DeepSeek 函数调用串联路线规划 / 比价 / 百度地图搜宝藏地点；无 Key 自动降级规则，绝不编造
- **数据库事务**：发帖用事务原子写入「帖 + 优点标签」，保证一致性
- **SQL 聚合/排名**：热度加权、高频优点提取、热门帖排序，覆盖真实数据分析场景
- **运营维护可观测**：请求日志中间件 + `/api/health` + `/api/admin/ops` 运维看板
- **前后端全链路**：REST API + 单文件 SPA（口碑榜 / 发帖 / 规划 / 比价 / AI 助手 / 社区 / 运维 七模块）

## 快速开始

```bash
cd backend
npm install        # 仅装 express（纯 JS，无原生编译）
npm start          # 等价于 node --experimental-sqlite server.js
# 打开 http://localhost:3000
```

演示账号（含 6 地点 / 12 帖 / 价格比较种子数据）：

| 账号 | 密码 | 角色 |
|------|------|------|
| 旅行者小明 | travel123 | 普通用户 |
| 吃货阿珍 | travel123 | 普通用户 |
| 平台管理员 | admin123 | 管理员（可置顶地点） |

## 验证

```bash
npm run smoke      # 全链路冒烟测试，覆盖注册/登录/发帖/投票/榜单/AI总结/规划/比价/RBAC
```

## API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/register` `/api/login` `/api/refresh` `/api/logout` | 鉴权 |
| GET | `/api/leaderboard` | 聚合口碑总榜（核心） |
| POST | `/api/posts` | 发帖（事务） |
| POST | `/api/posts/:id/vote` | 投票 |
| POST | `/api/summarize/:locationId` | AI 口碑总结 |
| POST | `/api/plan` | 行程规划 + 比价 |
| GET | `/api/price/:locationId` | 单地点比价 |

## 目录结构

```
travel-rank/backend/
├── server.js          # Express 服务 + API + 静态托管 + 请求日志
├── src/
│   ├── db.js          # node:sqlite 建表/种子/读写（含密码哈希/绑定/评论/运维统计）
│   ├── auth.js        # JWT 双 token + RBAC + 手机号/微信/QQ 登录绑定（crypto 原生）
│   ├── aggregator.js  # 聚合排名引擎（热度/优点/热门帖）
│   ├── llm.js         # LLM 总结 + 规则兜底
│   ├── agent.js       # AI 旅行助手（DeepSeek 函数调用 + 百度地图工具 + 规则兜底）
│   └── planner.js     # 行程规划 + 价格比较
├── public/            # 单文件 SPA（口碑榜/发帖/规划/比价/AI助手/社区/运维）
└── test_smoke.mjs     # 全链路测试
```

MIT License。
