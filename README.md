# 家助宝项目

## About / 企业端原型入口

家助宝企业端是一款面向南康区家具产业的惠企政策智能服务平台原型，旨在解决企业面临的政策找不到、读不懂、申报填表繁、审核周期长四大核心痛点。在产品设计前期，团队深入走访12个委办局及60家家具企业，精准识别出政策信息差、单次填表耗时2小时、平均审核等待3天等关键堵点，以此驱动功能架构设计。

- **企业端八页交互原型入口**：打开仓库根目录的 [`index.html`](index.html)
- **GitHub Pages 展示地址**：启用 Pages 后访问 `https://areskkk.github.io/-/`
- **项目内真实前端入口**：启动项目后访问 `/enterprise/dashboard`

通过 `index.html` 的 About 区块点击 **打开企业端原型**，即可进入企业端展示界面；页面内部的侧边栏、顶部导航和按钮可以串联展示八个企业端页面：企业工作台、企业绑定页、企业画像维护、政策问答页、我的申报列表、新建申报页、申报详情页和补正处理页。

## 企业端原型包含页面

1. 企业工作台
2. 企业绑定页
3. 企业画像维护
4. 政策问答页
5. 我的申报列表
6. 新建申报页
7. 申报详情页
8. 补正处理页

页面之间可通过顶部导航、侧边栏和页面内部按钮跳转，上传、筛选、聊天、提交、弹窗等关键交互以静态演示方式实现。

## Current repository scope

- Batch 1: TypeScript + Fastify API skeleton, PostgreSQL SQL migrations, shared error/response/pagination base
- Batch 2: auth, enterprise binding, current enterprise profile, policy import/query/publish, audit persistence, minimal permission checks
- Batch 3: single-policy application draft, submit flow, enterprise profile snapshot freezing, `draft -> submitted`

## Local Start

```bash
npm install
npm run dev
```

The app reads `.env` by default. See `.env.example`.

## Database Migration

```bash
npm run migrate
```

`DATABASE_URL` must point to a writable PostgreSQL instance.

## PostgreSQL Test Prerequisite

Batch 2 and Batch 3 integration tests perform real database writes. They require PostgreSQL.

Recommended local Docker setup:

```bash
docker run --name nankang-postgres-test ^
  -e POSTGRES_PASSWORD=postgres ^
  -e POSTGRES_DB=nankang_zhuqibao ^
  -p 5432:5432 ^
  -d postgres:15-alpine
```

Set the test database URL:

```bash
set DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/nankang_zhuqibao
```

## Test Strategy

The real write integration tests share one PostgreSQL database and truncate business tables between cases.

Because of that, they must not run in parallel with other integration files.

Current strategy:
- `vitest.config.ts` sets `fileParallelism = false`
- `npm test` runs non-integration tests first, then runs integration tests
- `npm run test:integration` runs only:
  - `test/batch2.integration.test.ts`
  - `test/batch3.integration.test.ts`

Recommended verification order:

```bash
npm run build
npm run migrate
npm test
```

Run only the real write integration suite:

```bash
npm run test:integration
```

## Health Check

```bash
curl http://localhost:3000/health
```
