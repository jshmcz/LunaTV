# LunaTV 站长增强补丁包（jshmcz 仓库）

在去广告增强版基础上，新增 5 项能力，**全部基于你 fork 的 `jshmcz` 仓库、直接改源码**：
去广告补丁不变，本包是叠加的第二套补丁。

## 一、包含功能

| 需求 | 实现 |
|---|---|
| 1. 站长查看各用户登录/播放情况 | admin 新增「站长」Tab：用户活动表（播放数、最近播放、搜索数、在线状态、活跃终端数、累计终端数） |
| 2. 在线检测并升级 | 站长 Tab 内「在线升级」区：检测 GitHub 新版本 + 一键触发升级（webhook 交给 NAS 宿主机执行） |
| 3. 全部基于 jshmcz 仓库 | 编译产出的镜像推送到 `ghcr.io/jshmcz/lunatv`，Actions 在该仓库运行 |
| 4. 互踢、去掉网关 | 单 Web 会话：新登录顶掉旧会话；无需外部 gateway 容器，直接暴露 3000 端口 |
| 5. 终端 ID 识别 | 浏览器持久 deviceId；站长可看每个用户活跃终端数、累计终端数、设备明细、互踢痕迹 |

## 二、设计取舍（重要）

- **互踢是「秒级软互踢」**：客户端 SessionGuard 每 15 秒 + 切回前台时校验一次会话，被顶下线后自动跳登录页并提示。
  不是逐请求硬拦截——因为 LunaTV 的 `proxy.ts` 跑在 Edge runtime，无法查数据库；
  这样设计换来的是**零改 proxy、零改数据库表结构、TVBox 完全不受影响**。
- **TVBox 豁免**：TVBox 用 key 接入，不经过浏览器登录组件，天然不参与互踢。
- **所有会话数据存在现有 `cache` 表**（key 前缀 `owner:sess:`），sqlite/redis/upstash/kvrocks 四种后端通用，
  8 天自动过期，不新增数据库表，上游升级零冲突。
- **登录/登出用「门面」**：原 `route.ts` 备份为 `route.orig.ts`，新 `route.ts` 包一层。
  官方登录逻辑一行不改，上游升级重新套补丁时冲突面积极小。

## 三、目录结构

```
owner-patch/
├── apply_owner_patch.sh          # 主补丁脚本（幂等）
├── files/
│   ├── lib/session.ts            # 会话层（存 cache 表）
│   ├── lib/device.ts             # 浏览器持久终端 ID
│   ├── components/SessionGuard.tsx  # 互踢守卫 + 设备头注入
│   ├── components/OwnerSection.tsx  # 站长面板 UI
│   └── api/
│       ├── login-route.facade.ts       # 登录门面
│       ├── logout-route.facade.ts      # 登出门面
│       ├── session-verify-route.ts     # 会话校验 API
│       ├── owner-overview-route.ts     # 站长数据 API
│       └── upgrade-route.ts            # 检测/升级 API
├── nas/upgrade-webhook.py        # NAS 宿主机升级服务
└── workflow/build.yml            # 整合版 Actions（去广告+站长一起编译）
```

## 四、GitHub 仓库需要放的文件

把你 fork 的 `jshmcz` 仓库当作「补丁仓库」，目录结构如下（与现有去广告补丁仓库合并）：

```
jshmcz 仓库根目录/
├── apply_patch.sh                    # 已有（去广告主脚本，本次修了 2 处校验）
├── Dockerfile                        # 已有（含 python 编译工具链）
├── patch/                            # 已有（去广告模块）
│   ├── heuristicAdFilter.ts
│   ├── enhancedAdFilter.ts
│   ├── optimizedProbe.ts
│   └── pcrAdFilter.facade.ts
├── owner-patch/                      # 【新增】本包整个目录
│   ├── apply_owner_patch.sh
│   ├── files/...
│   ├── nas/...
│   ├── workflow/...
│   └── README.md
└── .github/workflows/build.yml       # 用本包的 workflow/build.yml 覆盖
```

## 五、首次部署步骤

### 1. 编译镜像
在 GitHub 仓库 Actions 页 → `Build LunaTV Enhanced` → Run workflow：
- **version**：填**官方源码** `laboratorys/LunaTV` 真实存在的 tag（如 `5.1.8`）。
  **必须是官方仓库有的 tag**——这里填 `5.1.8.1` 这类自定义号会在 checkout 步骤失败。
- **image_tag**：填**你自己产出镜像**的标签，可用任意自定义版本号，如 `5.1.8.1`、
  `5.1.8-enhanced`。留空则与 version 相同。想要增强版叫 `5.1.8.1`，就在这里填。

> 两个框的区别：`version` 决定**拉哪份官方代码**，`image_tag` 决定**生成的镜像叫什么名字**。
> 例：想要增强版号 `5.1.8.1` → version 填 `5.1.8`，image_tag 填 `5.1.8.1`。

等待完成。产出：`ghcr.io/jshmcz/lunatv:<image_tag 或 version>` 和 `:latest`（含去广告 + 站长全部增强）。
每次构建只新增自己的 tag，**不需要也不建议删除旧镜像**——不同 tag 可共存，旧镜像留作回滚；
仅 `:latest` 会指向最新构建。

### 2. 部署 NAS 上的升级 webhook（在线升级用）

把 `nas/upgrade-webhook.py` 传到 NAS（如 `/vol1/lunatv/upgrade-webhook.py`），后台启动：

```bash
nohup python3 /vol1/lunatv/upgrade-webhook.py \
  --host 0.0.0.0 --port 10099 \
  --token '换个强随机令牌' \
  --compose /vol1/lunatv/docker-compose.yml \
  --service lunatv-core \
  --owner jshmcz \
  > /vol1/lunatv/data/webhook.log 2>&1 &
```

### 3. 更新 docker-compose.yml

- 去掉 gateway 服务（不再需要），把 core 端口直接映射出来；
- core 增加三个环境变量（在线升级用）：

```yaml
services:
  lunatv-core:
    image: ghcr.io/jshmcz/lunatv:5.1.8
    ports:
      - '10002:3000'
    environment:
      - UPGRADE_WEBHOOK_URL=http://<NAS内网IP>:10099/upgrade
      - UPGRADE_WEBHOOK_TOKEN=换个强随机令牌   # 与上面一致
      # - UPGRADE_VERSION_URL=https://...      # 可选，自定义版本文件地址
    # ... 其余原有配置（USERNAME/PASSWORD/ volumes 等）保持不变
```

> 注意：容器内访问 webhook 要用 **NAS 的内网 IP**（如 `http://192.168.123.153:10099`），不能用 `localhost`（那是容器自己）。

### 4. 重建容器

```bash
cd /vol1/lunatv
sudo docker compose up -d --no-deps --force-recreate lunatv-core
```

### 5. 验证

1. 用站长账号登录 → 管理面板出现「站长」Tab；
2. 「站长」Tab 能看到用户活动、终端列表、在线升级区；
3. 用同一账号在浏览器 B 登录 → 浏览器 A 在 15 秒内被顶下线并提示；
4. 在线升级区点「重新检测」，确认能读到版本信息。

## 六、后续上游升级怎么简单改造（核心诉求）

 upstream 发新版本后，你**不需要手动改任何源码**，只需 3 步：

1. GitHub 仓库 Actions → Run workflow → 填新版本号（如 `5.2.0`）→ 自动拉官方新源码 + 套两套补丁 + 编译推镜像；
2. NAS 上执行：
   ```bash
   cd /vol1/lunatv
   sudo docker pull ghcr.io/jshmcz/lunatv:5.2.0
   sudo sed -i "0,/image: .*/s#image: .*#image: ghcr.io/jshmcz/lunatv:5.2.0#" docker-compose.yml
   sudo docker compose up -d --no-deps --force-recreate lunatv-core
   ```
   或者直接在网页「站长 → 在线升级」点按钮自动完成第 2、3 步；
3. 完成。所有增强自动保留。

**只有当官方大改导致补丁锚点失配时**（apply 脚本会明确报错），才需要更新补丁文件——
正常小版本升级锚点不会变。

## 七、回滚

镜像保留旧 tag，回滚只需把 compose 的 image 改回旧版本并 recreate：

```bash
sudo sed -i "0,/image: .*/s#image: .*#image: ghcr.io/jshmcz/lunatv:5.1.8#" docker-compose.yml
sudo docker compose up -d --no-deps --force-recreate lunatv-core
```
