# 部署说明

> 重要：更新代码时绝对不要删除以下目录：
>
> ```text
> /vol2/1000/deploy/ShuijingCloud/storage
> /vol2/1000/deploy/ShuijingCloud/logs
> /vol2/1000/deploy/mysql
> ```
>
> 前两个保存用户文件与日志，最后一个保存用户、会话以及 SupaAiMd 等共用数据库。

当前部署目标：

- 服务器：`shuijing.site`
- SSH 端口：`12222`
- 部署目录：`/vol2/1000/deploy/ShuijingCloud`
- 应用代码：`/vol2/1000/deploy/ShuijingCloud/app`
- 容器：`shuijing-cloud`，监听 `0.0.0.0:8080`（HTTPS）
- 前端与 API 同源，由 Node 进程直接提供
- 对外入口：`https://shuijing.site:8080`
- 敏感配置：`/vol2/1000/deploy/ShuijingCloud/.env`（权限 `600`）

## 首次部署 / 更新

```bash
rsync -az --exclude node_modules --exclude .env --exclude test \
  -e "ssh -i ~/Documents/id_rsa_macos -p 12222" \
  server/ shuijing@shuijing.site:/vol2/1000/deploy/ShuijingCloud/app/server/

rsync -az --exclude .DS_Store \
  -e "ssh -i ~/Documents/id_rsa_macos -p 12222" \
  frontend/ shuijing@shuijing.site:/vol2/1000/deploy/ShuijingCloud/app/frontend/

ssh -i ~/Documents/id_rsa_macos -p 12222 shuijing@shuijing.site '
  cd /vol2/1000/deploy/ShuijingCloud/app &&
  docker build -f server/Dockerfile -t shuijing-cloud:latest . &&
  docker rm -f shuijing-cloud
'
```

启动容器：

```bash
docker run -d --name shuijing-cloud --restart unless-stopped \
  -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  --env-file /vol2/1000/deploy/ShuijingCloud/.env \
  -v /vol2/1000/deploy/ShuijingCloud/storage:/data/storage \
  -v /vol2/1000/deploy/ShuijingCloud/logs:/data/logs \
  -v "/vol2/1000/deploy/证书文档/Nginx:/certs:ro" \
  shuijing-cloud:latest
```

## 数据库

- 数据库名：`ShuijingCloud`
- 应用账号：`shuijing_cloud`，仅拥有 `ShuijingCloud.*` 权限
- MySQL 容器：`mysql`，端口 `3306`
- 容器内通过 `host.docker.internal:3306` 访问

## 验证

```bash
docker ps --filter name=shuijing-cloud
docker logs --tail 50 shuijing-cloud
curl -k https://shuijing.site:8080/api/health
```

正常应返回 `{"ok":true}`，用户端与管理端页脚版本号一致。

## 本地开发隧道

`/etc/ssh/sshd_config.d/00-allow-forwarding.conf` 已启用 `AllowTcpForwarding yes`，本地可执行：

```bash
ssh -i ~/Documents/id_rsa_macos -p 12222 \
  -L 3306:127.0.0.1:3306 shuijing@shuijing.site
```

> fnOS 升级后如覆盖了 sshd 配置，需重新创建该文件并 `systemctl reload ssh`。
