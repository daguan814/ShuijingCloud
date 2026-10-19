# 水镜云盘（ShuijingCloud）

面向班级的文件云盘：按班级与学生隔离目录，学生自助上传、下载与整理文件，管理员统一管理用户组、注册审核、共享文件、回收站与操作日志。

后端已迁移到 Node.js（Express 5 + mysql2），前端保持静态 Vue 3，无需构建步骤，由 Node 进程同源提供页面与 API。

## 功能

- 用户注册时选择用户组，填写用户名、密码和确认密码，审核通过后才能登录；
- 用户按用户组和用户名隔离存储，目录结构为 `storage/<用户组>/<用户名>/`；
- 管理员后台位于 `/admin/`，可以新增、改名和删除空用户组；
- 管理员可以审核注册、修改用户名/用户组/密码、禁用账号，并谨慎删除用户；
- 管理员改名或转组时，对应文件目录同步移动；
- 管理员选择用户组后可直接查看该组用户目录，并像个人云盘一样逐级浏览、上传、新建、重命名、移动、删除和下载文件；
- 管理员个人文件可共享给指定用户组；
- 管理员可以按用户组发布公告，用户可以向管理员提交报告；
- 浏览目录、查看修改时间和普通文件大小；
- 文件夹显示直接下一层的文件夹数、文件数以及全部内容总大小；
- 上传单个文件、多个文件或完整文件夹，支持拖放并保留目录结构；
- 新建文件夹、单项重命名、批量移动和批量删除；
- 学生删除内容后进入统一回收站，管理员可以恢复；
- 图片、音频、视频与文本文件支持浏览器原生在线预览；PDF / Office 文档不再提供在线预览，请下载后查看；
- 单个文件支持浏览器原生下载与 Range 请求，多文件或文件夹在服务器生成 ZIP 后下载；
- 文件操作日志统一在管理后台查看，可按班级、学生、日期与操作类型组合筛选；
- 同一浏览器连续登录失败 5 次后锁定 5 小时；
- 显示用户已用空间和服务器磁盘容量。

## 目录结构

```text
server/            Node.js 服务（Express 5）
  src/routes/      API 路由：auth / files / recycle / logs / admin
  src/services/    文件、回收站、管理员文件、学校与日志服务
  src/lib/         密码校验、路径安全、票据签名、ZIP
  test/            node:test 单元测试
frontend/          静态 Vue 3 页面与管理端
backend/           旧 Python 实现，仅作迁移对照，不再部署
deploy/            部署说明与历史配置
```

## 存储模型

- 用户文件：`$STORAGE_ROOT/<班级 storage_key>/<用户 storage_key>/`
- 用户回收站：`$RECYCLE_ROOT/<班级>/<用户>/<随机名>`
- 管理员个人文件：`$STORAGE_ROOT/管理员文件/<管理员用户名>/`
- 管理员回收站：`$RECYCLE_ROOT/管理员文件/<管理员用户名>/`
- 删除学生账号时，其目录移动到 `$STORAGE_ROOT/回收站/已删除学生/`

数据库沿用旧表名（`storage_users`、`admin_users`、`sessions` 等），账号密码哈希为 Werkzeug `scrypt:32768:8:1`，Node 端可直接校验，无需重置密码。

## 本地开发

### 1. 建立数据库隧道

生产 MySQL 只允许经 NAS 访问：

```bash
ssh -i /Users/shuijing/Documents/id_rsa_macos -p 12222 \
  -L 3306:127.0.0.1:3306 shuijing@shuijing.site
```

### 2. 配置环境变量

```bash
cp .env.example server/.env
```

本地开发时把 `DB_HOST` 设为 `127.0.0.1`，`DB_USER` 使用测试账号或 `root`，`STORAGE_ROOT` 指向本地临时目录。

### 3. 安装与启动

```bash
cd server
npm install
DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD='***' DB_NAME=ShuijingCloud_test \
STORAGE_ROOT=/tmp/shuijing-storage APP_PORT=8080 node src/index.js
```

访问 `http://127.0.0.1:8080/`（用户端）与 `/admin/`（管理端）。

### 4. 测试

```bash
cd server && npm test
```

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `APP_HOST` / `APP_PORT` | 监听地址与端口 | `0.0.0.0` / `8080` |
| `DB_HOST` / `DB_PORT` | MySQL 地址 | `127.0.0.1` / `3306` |
| `DB_USER` / `DB_PASSWORD` | 数据库账号 | `root` / 空 |
| `DB_NAME` | 数据库名 | `ShuijingCloud` |
| `STORAGE_ROOT` | 用户文件根目录 | `./storage` |
| `RECYCLE_ROOT` | 回收站根目录 | `$STORAGE_ROOT/回收站` |
| `LOG_DIR` | 访问日志目录 | 不写文件 |
| `MAX_CONTENT_LENGTH` | 单文件上传上限（字节） | `10737418240`（10GB） |
| `SECRET_KEY` | 票据与管理员 token 签名密钥 | 开发默认值 |
| `RECYCLE_BIN_PASSWORD` | 用户自助恢复回收站口令 | 空（未启用） |
| `TLS_CERT` / `TLS_KEY` | HTTPS 证书与私钥；都设置时启用 HTTPS | 空（HTTP） |
| `ALLOWED_ORIGINS` | 额外允许的跨域来源 | `http://127.0.0.1:5173` |

## API

所有接口以 `/api` 为前缀，认证使用 `Authorization: Bearer <token>`，错误统一返回 `{"detail": "..."}`。

- `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`
- `GET /api/auth/classes`、`POST /api/auth/register`、`GET /api/auth/announcements`
- `GET /api/auth/shared-files`、`GET /api/auth/shared-files/:id`
- `POST /api/auth/shared-files/:id/download/prepare`、`GET /api/auth/shared-files/download/ticket/:ticket`
- `POST /api/auth/reports`
- `GET/POST /api/files`、`/upload`、`/mkdir`、`/download`、`/delete`、`/batch-delete`、`/move`、`/rename`
- `POST /api/files/download/prepare`、`GET /api/files/download/ticket/:ticket`
- `GET /api/recycle`、`POST /api/recycle/:id/restore`
- `GET /api/logs`
- `POST /api/admin/login`、`GET /api/admin/overview`、`/dashboard-stats`、`/messages`、`/logs`
- 管理端用户组、注册审核、学生、管理员、公告、回收站、个人文件、班级文件、学生文件与共享接口
- `GET /api/health`

文档预览接口保留但只对图片、音视频与文本生效；PDF / Office 返回 415。

## 生产部署

详见 [deploy/README.md](deploy/README.md)。生产形态：

- 容器 `shuijing-cloud`，`restart unless-stopped`，`-p 8080:8080`
- Node 直接使用 `shuijing.site` 证书提供 HTTPS
- 挂载 `storage`、`logs` 与只读证书目录
- 通过 `host.docker.internal:3306` 连接 NAS 上的 MySQL

## 数据安全

以下目录保存真实用户数据，任何更新都不得删除或清空：

```text
/vol2/1000/deploy/ShuijingCloud/storage
/vol2/1000/deploy/ShuijingCloud/logs
/vol2/1000/deploy/mysql
```
