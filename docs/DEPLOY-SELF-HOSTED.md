# 自建服务器部署与更新手册（本人环境）

> 这份手册记录**我这台机器**的实际操作：Debian 系 Linux、root 账户、装在 `/opt/stronghold`。
> 上游的通用说明见 [docs/DEPLOY.md](DEPLOY.md)；本文只写「怎么开、怎么更、坏了怎么查」。
> 仓库：<https://github.com/daa0v0/Stronghold-Protocol>（默认分支 `master`）。

## 0. 一句话速查

```bash
# 更新并重启（日常只用这三条）
cd /opt/stronghold && git pull && npm ci --omit=dev
systemctl restart stronghold
curl -s localhost:3000/healthz
```

## 1. 这套东西由什么组成

| 位置 | 是什么 | 在 git 里吗 |
|---|---|---|
| `/opt/stronghold/server`、`shared`、`public/js`、`public/css` | 服务端与浏览器客户端代码 | ✅ 在 |
| `/opt/stronghold/data/*.json` | 由官方数据表生成的游戏数据（含皮肤清单） | ✅ 在 |
| `/opt/stronghold/node_modules` | 依赖（`npm ci` 生成） | ❌ 不在 |
| `/opt/stronghold/public/vendor` | pixi / preact / three 等前端库（postinstall 生成） | ❌ 不在 |
| `/opt/stronghold/public/assets` | **游戏美术与音频，约 735 MB** | ❌ 不在（版权原因） |
| `/opt/stronghold/public/assets/char/skin_avatar`、`spine/op/<干员>/<皮肤>` | **干员皮肤素材，约 380 MB** | ❌ 不在（走 GitHub Releases） |

记忆点：**代码走 git，素材走 setup 与 Releases。** 重装机器时这两样都要重新准备。

## 2. 首次部署（从零到能玩）

### 2.1 前置

- Node.js **≥ 22**（本机 v22.23.3）、git、约 **2 GB** 空闲磁盘
- 以下命令都以 **root** 执行，目录固定 `/opt/stronghold`

```bash
node -v && git --version && df -h /opt
```

### 2.2 拉代码

```bash
cd /opt/stronghold
git clone -b master https://github.com/daa0v0/Stronghold-Protocol.git .
```

GitHub 连不上时（国内常见 `Connection reset`）先挂代理前缀再重试：

```bash
git config --global url."https://gh-proxy.com/https://github.com/".insteadOf "https://github.com/"
```

### 2.3 装依赖

```bash
cd /opt/stronghold
npm ci --omit=dev          # 约 100 个包；postinstall 会生成 public/vendor
```

### 2.4 下素材（约 723 MB，可中断续传）

**必须加 `--asset-source=mirror`**：本机直连 `raw.githubusercontent.com` / `cdn.jsdelivr.net` 会失败。

```bash
cd /opt/stronghold
nohup node tools/setup.mjs --yes --no-local --asset-source=mirror > /opt/setup.log 2>&1 &
tail -f /opt/setup.log
```

正常进度长这样：

```
[spine] 742/2133 ok=742 skip=0 miss=0 err=0 103.9 MB 3.92 MB/s
```

中断了就直接再跑同一条命令，会**续传**。有 HTTP 代理时可以先 `export HTTPS_PROXY=... HTTP_PROXY=...` 再跑（Node 22.21+ 支持）。

下完自检：

```bash
find /opt/stronghold/public/assets -type f | wc -l   # 完整接近 12250
du -sh /opt/stronghold/public/assets                 # 约 735 MB
```

### 2.5 皮肤素材（约 180 MB）

皮肤美术不在 git 里，放在仓库的 **Releases**（tag `assets-v1`）：

```bash
cd /opt/stronghold/public/assets
curl -L -o av.tar.gz https://github.com/daa0v0/Stronghold-Protocol/releases/download/assets-v1/stronghold-skins-avatars.tar.gz
tar -xzf av.tar.gz && rm av.tar.gz          # 解出 char/skin_avatar/*.png（271 张）
curl -L -o md.tar.gz https://github.com/daa0v0/Stronghold-Protocol/releases/download/assets-v1/stronghold-skins-models.tar.gz
tar -xzf md.tar.gz && rm md.tar.gz          # 解出 spine/op/<干员>/<皮肤>/*.{skel,atlas,png}（172 套）
```

只装头像包也能玩：皮肤卡片有各自的图，战场模型仍用干员本体。

### 2.6 自检并手动试跑

```bash
cd /opt/stronghold
node tools/doctor.mjs
PORT=3000 HOST=0.0.0.0 node server/index.js     # Ctrl+C 停
# 另开终端：
curl -s localhost:3000/healthz                  # 期望 {"ok":true,...}
```

浏览器打开 `http://服务器IP:3000` → 同盟模拟 → 选 20 人 → 创建同盟。

### 2.7 常驻（systemd）

```bash
cat > /etc/systemd/system/stronghold.service <<'EOF'
[Unit]
Description=Stronghold Protocol
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/stronghold
Environment=PORT=3000
Environment=HOST=0.0.0.0
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now stronghold
systemctl status stronghold --no-pager
curl -s localhost:3000/healthz
```

## 3. 日常更新

```bash
cd /opt/stronghold
git pull                     # 代码 + 数据（data/*.json）
npm ci --omit=dev            # package.json 变了才需要，但每次都跑也不贵
systemctl restart stronghold
curl -s localhost:3000/healthz
journalctl -u stronghold -n 50 --no-pager     # 起不来时看日志
```

什么时候还要额外跑 `setup`：

| 变化 | 要做的事 |
|---|---|
| 只是代码/规则改动 | `git pull` + 重启 |
| `data/assets.json` 多了新素材条目（新干员/新皮肤） | 再跑一次 `node tools/setup.mjs --yes --no-local --asset-source=mirror` 补齐 |
| 换了皮肤包版本 | 重新从 Releases 下载并解包到 `public/assets` |

## 4. 常用运维命令

```bash
systemctl status stronghold            # 运行状态
systemctl restart stronghold           # 重启
journalctl -u stronghold -f            # 实时日志
journalctl -u stronghold --since "1 hour ago" --no-pager
ss -lntp | grep 3000                   # 确认端口在听
curl -s localhost:3000/healthz         # 健康检查（含在线人数、房间数）
du -sh /opt/stronghold /opt/stronghold/public/assets
```

停止/禁用：

```bash
systemctl disable --now stronghold
```

## 5. 端口与环境变量

改端口就改 unit 里的 `Environment=PORT=3000`，然后 `systemctl daemon-reload && systemctl restart stronghold`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `::`（双栈） | 写 `0.0.0.0` 只监听 IPv4；只有本机用就写 `127.0.0.1` 配合反代 |
| `SP_COMBAT` | `client` | 战斗在玩家浏览器里模拟，服务器省 CPU（20 人也保持 client） |
| `SP_VERIFY` | `off` | `sample` 约 1/8 抽查复算，`all` 全部复算（很吃 CPU） |
| `TRUST_PROXY` | `auto` | 放在 nginx 后面时让 `X-Forwarded-For` 生效 |
| `DEBUG` | 空 | 设任意值输出详细日志 |

## 6. 外网访问排查

1. **服务在监听吗**：`ss -lntp | grep 3000`（应显示 `0.0.0.0:3000` 或 `*:3000`）
2. **云厂商安全组**：VPS 控制台放行 3000（或 80/443），这一步在服务器里改不了
3. **本机防火墙**：`ufw status` / `iptables -L -n | head`
4. **本地验证**：`curl -s localhost:3000/healthz`（本机能通、外面不通 → 一定是 2 或 3）
5. 浏览器卡在旧版本：`Ctrl+F5` 强制刷新（客户端有构建标记，服务端重启后页面会发现新版本）

## 7. 想上 HTTPS（可选）

```bash
apt install -y nginx certbot python3-certbot-nginx
cat > /etc/nginx/sites-available/stronghold <<'EOF'
server {
  listen 80;
  server_name game.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;        # 必须：WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;                      # 一局可能很久
    proxy_buffering off;                           # /assets 大文件别缓冲
  }
  gzip off;                                        # 服务端自己压缩
}
EOF
ln -s /etc/nginx/sites-available/stronghold /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d game.example.com
```

上了反代之后把 unit 里的 `HOST` 改成 `127.0.0.1`，只让 nginx 对外。

## 8. 备份与回滚

- **要备份的**：没有数据库。真正需要保留的是「你的配置与自定义」；游戏进度都在玩家浏览器里。
  ```bash
  tar czf /root/stronghold-etc-$(date +%F).tar.gz -C /opt/stronghold systemd 2>/dev/null
  cp /etc/systemd/system/stronghold.service /root/
  ```
- **回滚代码**：
  ```bash
  cd /opt/stronghold
  git log --oneline -10                 # 找到要回到的提交
  git checkout <提交>
  npm ci --omit=dev && systemctl restart stronghold
  # 想回到最新：git checkout master && git pull
  ```

## 9. 分支说明（这个仓库有三条线）

| 分支 | 内容 |
|---|---|
| **`master`** | 主线：上游 v0.3.1 + 20 人容量 + 新 UI + 皮肤导出/导入 |
| `legacy-0.2.4-mods` | 旧线存档：v0.2.4 + 代码 mod / 房间 mod 对话框 |
| `capacity-0.3.1` | 与 `master` 同一个提交，留作别名 |

## 10. 玩家侧要点（20 人房）

- 建房时房主选 **4 / 8 / 10 / 16 / 20** 人（默认 4），开始后不能再改
- 20 人时每 4 人一组：组内共享卡池、各组并行选策略与机变
- 战斗在各自浏览器里跑；观战最多 2 人
- 首次进房会懒加载素材（浏览器缓存后不再下载）

## 11. 常见问题速查

| 现象 | 处理 |
|---|---|
| `setup` 报 `cannot fetch https://raw.githubusercontent.com/...` | 加 `--asset-source=mirror`，或先设 `HTTPS_PROXY` |
| `git clone` 卡住 / `Connection reset` | 挂 `gh-proxy.com` 前缀或重试 |
| 页面能开但模型/立绘缺失 | `public/assets` 没下全：`node tools/setup.mjs --yes --no-local --asset-source=mirror` |
| 皮肤卡片都一样 / 都是干员本体 | 皮肤头像没铺：解包 `stronghold-skins-avatars.tar.gz` 到 `public/assets` |
| 启动即退出 | `journalctl -u stronghold -n 50 --no-pager`；常见是 `node_modules` 没装或 Node < 22 |
| 房间只能进 8 人 | 建房时没选 20 人档位，或房主把容量设小了（房间界面「人数上限」） |
