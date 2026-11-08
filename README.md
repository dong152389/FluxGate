# FluxGate

一个面向个人和小团队的 VPN 订阅聚合项目。

它提供：

- 多订阅源聚合
- 用户注册 / 登录
- 每个用户独立配置与公开订阅 token
- `vmess` / `vless` 节点解析与重命名
- 去重
- 单节点别名
- Clash / Mihomo / V2Ray 格式订阅导出

## 技术栈

- 运行环境: Node.js (v22+)
- 数据库: MySQL 5.7+ / 8.0+
- 开发语言: TypeScript
- 前端: 原生静态前端（SPA 架构）

## 本地开发

1. 安装依赖

```bash
npm install
```

2. 准备环境变量

复制环境变量模板文件：

```bash
cp .env.example .env
```

并在 `.env` 中配置你的 MySQL 数据库连接信息及 `APP_SECRET`：

```env
PORT=80
APP_SECRET=your-random-strong-secret
PUBLIC_BASE_URL=http://localhost:80
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=fluxgate
```

3. 启动开发服务

```bash
npm run dev
```

服务启动时会自动连接 MySQL 并初始化所需数据表结构。

默认访问地址：
- 管理控制台: `http://localhost:80/`
- 公开订阅地址: `http://localhost:80/sub/{token}`

4. 类型检查

```bash
npm run typecheck
```

## Docker 容器化部署

项目中已提供 `docker-compose.yml`，可配合已有 MySQL 容器或独立部署：

```bash
docker compose up -d
```

### 环境变量说明

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 监听端口 | `80` |
| `APP_SECRET` | 数据加密密钥（请修改为随机高强度字符串） | - |
| `PUBLIC_BASE_URL` | 公开访问基础域名或 IP | `http://localhost:80` |
| `MYSQL_HOST` | MySQL 主机地址 | `localhost` |
| `MYSQL_PORT` | MySQL 端口 | `3306` |
| `MYSQL_USER` | MySQL 用户名 | `root` |
| `MYSQL_PASSWORD` | MySQL 密码 | - |
| `MYSQL_DATABASE` | MySQL 数据库名称 | `fluxgate` |
| `MYSQL_URL` | MySQL 完整连接 URL（可选） | - |
| `SESSION_TTL_DAYS` | 登录会话有效期（天） | `30` |
| `CACHE_TTL_SECONDS` | 订阅缓存有效期（秒） | `600` |
| `SMTP_HOST` | 邮件服务器地址（可选） | - |
| `SMTP_PORT` | 邮件服务器端口（可选） | `465` |
| `SMTP_USER` | 邮件服务器用户名（可选） | - |
| `SMTP_PASS` | 邮件服务器密码（可选） | - |
| `SMTP_FROM` | 发件人名称与地址（可选） | - |
| `EMAIL_WHITELIST` | 允许注册的邮箱白名单（可选） | - |

## 目录结构

- `public/`: 静态前端资源文件
- `src/index.ts`: Node.js Web 服务入口与路由处理
- `src/lib/mysql.ts`: MySQL 连接池与初始化
- `src/lib/db-schema.ts`: MySQL 表结构定义
- `src/lib/data.ts`: 数据读写层
- `src/lib/subscription.ts`: 订阅解析、去重、重命名与生成
- `src/lib/security.ts`: 密码哈希、数据加解密与 token 处理
- `src/lib/email.ts`: 邮件与验证码发送
