# 项目维护注意事项

这是 `ShuijingCloud`（水镜云盘）项目。后端为 Node.js（`server/`），前端为静态 Vue 3（`frontend/`），生产环境以 Docker 容器运行。任何 Agent 更新或部署时，必须遵守以下数据安全规则。

## 生产服务器

- SSH：`shuijing.site:12222`
- 部署目录：`/vol2/1000/deploy/ShuijingCloud`
- 应用代码：`/vol2/1000/deploy/ShuijingCloud/app`
- 容器：`shuijing-cloud`，监听 `0.0.0.0:8080`（HTTPS）
- MySQL 容器：`mysql`，数据目录 `/vol2/1000/deploy/mysql`
- 数据库：`ShuijingCloud`，应用账号 `shuijing_cloud`（密码在服务器 `.env`）
- 对外地址：`https://shuijing.site:8080`

## 绝对不要删除或清空的持久化数据

```text
/vol2/1000/deploy/ShuijingCloud/storage
/vol2/1000/deploy/ShuijingCloud/logs
/vol2/1000/deploy/mysql
```

解释：

- `storage`：所有用户的真实文件、回收站与管理员文件。
- `logs`：运行日志，不要作为临时目录清理。
- `/vol2/1000/deploy/mysql`：MySQL 数据卷，保存用户、会话以及 SupaAiMd 等共用库。

以下路径也应谨慎处理：

```text
/vol2/1000/deploy/证书文档/Nginx
```

`证书文档/Nginx` 是共享 SSL 证书，多个容器在用。

## 更新规则

1. 只更新代码目录：

   ```text
   server/
   frontend/
   deploy/
   readme.md
   ```

2. 同步文件时优先使用 `rsync`，不要对整个项目根目录使用 `--delete`。

3. 禁止在服务器项目目录执行：

   ```bash
   rm -rf /vol2/1000/deploy/ShuijingCloud/storage
   rm -rf /vol2/1000/deploy/mysql
   rm -rf /vol2/1000/deploy/ShuijingCloud
   git clean -fdx
   ```

4. 更新后端或前端后，重新构建镜像并重启容器：

   ```bash
   cd /vol2/1000/deploy/ShuijingCloud/app
   docker build -f server/Dockerfile -t shuijing-cloud:latest .
   docker rm -f shuijing-cloud
   docker run -d --name shuijing-cloud --restart unless-stopped \
     -p 8080:8080 \
     --add-host=host.docker.internal:host-gateway \
     --env-file /vol2/1000/deploy/ShuijingCloud/.env \
     -v /vol2/1000/deploy/ShuijingCloud/storage:/data/storage \
     -v /vol2/1000/deploy/ShuijingCloud/logs:/data/logs \
     -v "/vol2/1000/deploy/证书文档/Nginx:/certs:ro" \
     shuijing-cloud:latest
   ```

5. 如果必须做可能影响数据或数据库的操作，先备份：

   ```text
   /vol2/1000/deploy/ShuijingCloud/storage
   /vol2/1000/deploy/mysql
   ```

## 本地开发目录

本地 `server/storage/` 只是本地预览使用的存储目录，已被 `.gitignore` 忽略。

不要把本地的 `server/storage/` 误认为生产数据。

## 数据库变更

- 优先做加法迁移，新增表或新增列。
- 不要直接删除用户表、会话表。
- 操作前备份 MySQL 数据目录或导出数据库。

## 版本号规则

- 每次面向用户的功能更新或问题修复，都必须同步更新用户端与管理端页脚版本号。
- 当前版本为 `V2.1`。后续版本按 `V2.2 → V2.3 → V3.0` 递增。
