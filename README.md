# FluxGate

一个面向个人和小团队的 VPN 订阅聚合项目。

它提供：

- 多订阅源聚合
- 用户注册 / 登录
- 每个用户独立配置与公开订阅 token
- `vmess` / `vless` 节点解析与重命名
- 去重
- 单节点别名
- Cloudflare Worker 发布新订阅链接

## 技术栈

- Cloudflare Worker
- Cloudflare D1
- Cloudflare KV
- 原生静态前端
- TypeScript

## 本地开发

1. 安装依赖

```bash
npm install
```

2. 复制环境示例

```bash
copy .dev.vars.example .dev.vars
```

3. 创建 Cloudflare 资源

```bash
wrangler d1 create fluxgate-db
wrangler kv namespace create CACHE
wrangler kv namespace create CACHE --preview
```

4. 把上一步返回的 `database_id`、`preview_database_id`、KV `id`、`preview_id` 写回 [wrangler.jsonc](/C:/Users/dong5/Desktop/sub/wrangler.jsonc)

5. 初始化本地数据库

```bash
npm run db:migrate:local
```

6. 启动本地开发

```bash
npm run dev
```

默认地址：

- 管理台: `http://localhost:8787/`
- 公开订阅: `http://localhost:8787/sub/{token}`

## 部署到 Cloudflare

1. 准备 D1、KV 和自定义域名
2. 把实际资源 ID 写入 [wrangler.jsonc](/C:/Users/dong5/Desktop/sub/wrangler.jsonc)
3. 写入生产密钥

```bash
wrangler secret put APP_SECRET
wrangler secret put PUBLIC_BASE_URL
```

4. 执行数据库迁移

```bash
wrangler d1 migrations apply fluxgate-db
```

5. 发布

```bash
npm run deploy
```

## 常用命令

```bash
npm run dev
npm run typecheck
npm run test
npm run cf-typegen
```

## 目录结构

- [public/index.html](/C:/Users/dong5/Desktop/sub/public/index.html): 管理台入口
- [public/app.js](/C:/Users/dong5/Desktop/sub/public/app.js): 前端交互逻辑
- [public/styles.css](/C:/Users/dong5/Desktop/sub/public/styles.css): 前端样式
- [src/index.ts](/C:/Users/dong5/Desktop/sub/src/index.ts): Worker API 路由
- [src/lib/subscription.ts](/C:/Users/dong5/Desktop/sub/src/lib/subscription.ts): 订阅解析、去重、重命名与序列化
- [src/lib/security.ts](/C:/Users/dong5/Desktop/sub/src/lib/security.ts): 密码哈希、URL 加密、token 工具
- [src/lib/data.ts](/C:/Users/dong5/Desktop/sub/src/lib/data.ts): D1 数据读写
- [migrations/0001_init.sql](/C:/Users/dong5/Desktop/sub/migrations/0001_init.sql): 数据库结构

## 当前支持

- 明文多行订阅
- Base64 订阅
- `vless://`
- `vmess://`

## 已知边界

- 当前前端是原生单页应用，没有接入 React
- 首版重点兼容 `vmess` / `vless`，其他协议会尽量保留原始内容
- 这是“服务端代拉取”架构，不是零知识架构，服务端运行时仍然能访问明文上游 URL
- `wrangler.jsonc` 里的资源 ID 现在是占位值，部署前必须替换
