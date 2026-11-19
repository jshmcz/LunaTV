# LunaTV 站长增强补丁包（jshmcz 仓库）

在去广告增强版基础上，新增 5 项能力，**全部基于你 fork 的 `jshmcz` 仓库、直接改源码**：
去广告补丁不变，本包是叠加的第二套补丁。

## 一、包含功能

| 需求 | 实现 |
|---|---|
| 1. 站长查看各用户登录/播放情况 | admin 新增「站长」Tab：用户活动表（播放数、最近播放、搜索数、在线状态、**在线设备数/累计设备数**、互踢次数） |
| 2. 在线检测并升级 | 站长 Tab 内「在线升级」区：**检测 GHCR 上自己编译产出的镜像 tag** + 一键触发升级（webhook 交给 NAS 宿主机执行） |
| 3. 全部基于 jshmcz 仓库 | 编译产出的镜像推送到 `ghcr.io/jshmcz/lunatv`，Actions 在该仓库运行 |
| 4. 互踢、去掉网关 | 单 Web 会话：新登录顶掉旧会话；无需外部 gateway 容器，直接暴露 3000 端口 |
| 5. 终端 ID 识别 | 浏览器持久 deviceId；站长可看每个用户活跃终端数、累计终端数、设备明细（含在线状态）、互踢痕迹 |
| 6. **登录设备数上限** | 单账号累计不同设备 > 30 台自动禁止**新设备**登录并在登录页提示；已知设备重登放行；**admin 账号豁免**。上限可用 `MAX_USER_DEVICES` 调整 |

### 本次迭代（相对首个增强版 5.1.8.1 的三项修复）

1. **升级检测真正可用**：版本源从「官方不存在的 `VERSION_main.txt`」改为「直接查 GHCR 上 `jshmcz/lunatv` 的 tags」——
   查到的就是能 pull 的镜像，闭环。支持 4 段版本号（如 `5.1.8.2 > 5.1.8.1`）；
   当前版本从环境变量 `CURRENT_IMAGE_TAG` 读取，webhook 升级成功后会自动同步该变量，面板不再显示旧版本。
2. **累计设备数可见**：修复此前只统计「当前活跃会话」导致互踢后看不到其他设备的 bug——
   新增 `devidx` 设备索引，登录时登记所有 deviceId，面板从索引全量遍历历史设备并标注在线状态。
3. **登录设备数上限 30**：按去重 deviceId 计数（不是互踢次数），全新设备超过上限则拒绝登录；
   admin 账号豁免，阈值可用 `MAX_USER_DEVICES` 改。

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
- core 增加以下环境变量（在线升级 + 版本显示 + 设备限制用）：

```yaml
services:
  lunatv-core:
    image: ghcr.io/jshmcz/lunatv:5.1.8.1
    ports:
      - '10002:3000'
    environment:
      - CURRENT_IMAGE_TAG=5.1.8.1              # 当前镜像 tag，面板显示"当前版本"用；升级后 webhook 自动同步
      - MAX_USER_DEVICES=30                    # 单账号最多登记多少台不同设备，超出禁止新设备登录；admin 豁免
      - GHCR_OWNER=jshmcz                      # GHCR 用户名（小写），检测新镜像用
      - GHCR_REPO=lunatv                       # GHCR 镜像名
      - UPGRADE_WEBHOOK_URL=http://<NAS内网IP>:10099/upgrade
      - UPGRADE_WEBHOOK_TOKEN=换个强随机令牌   # 与上面 webhook 的 --token 一致
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

## 六.5、本次迭代（设备上限/设备数显示/升级检测）的部署

这次改了源码，需重新编译 + 部署。以切到 `5.1.8.2` 为例：

1. 把更新后的补丁文件上传到 jshmcz 仓库对应路径（见第四节），尤其是：
   - `owner-patch/files/lib/session.ts`（devidx 索引 + checkDeviceLimit + active 字段）
   - `owner-patch/files/api/login-route.facade.ts`（设备数上限拦截）
   - `owner-patch/files/api/owner-overview-route.ts`（在线/累计设备数、互踢次数）
   - `owner-patch/files/components/OwnerSection.tsx`（前端列）
   - `owner-patch/files/api/upgrade-route.ts`（GHCR 版本检测）
   - `owner-patch/nas/upgrade-webhook.py`（升级后同步 CURRENT_IMAGE_TAG）
2. Actions → Run workflow：version 填 `5.1.8`，image_tag 填 `5.1.8.2`。
3. **先跑一次数据迁移**（为旧设备补建 devidx 索引，幂等可重复跑）：
   ```bash
   sudo python3 /vol1/lunatv/migrate_devidx.py /vol1/lunatv/data/tv.db
   ```
   不跑这步，升级前面板看不到历史设备（旧记录没有索引）。新登录的设备会自动进索引，不受影响。
4. 更新 webhook 脚本（覆盖 `/vol1/lunatv/upgrade-webhook.py` 后 `sudo systemctl restart lunatv-upgrade-webhook`）。
5. NAS 切换镜像：
   ```bash
   cd /vol1/lunatv
   sudo docker pull ghcr.io/jshmcz/lunatv:5.1.8.2
   sudo sed -i "0,/image: .*/s#image: .*#image: ghcr.io/jshmcz/lunatv:5.1.8.2#" docker-compose.yml
   # 同步更新 CURRENT_IMAGE_TAG（面板显示当前版本用）
   sudo sed -i "s/CURRENT_IMAGE_TAG=.*/CURRENT_IMAGE_TAG=5.1.8.2/" docker-compose.yml
   sudo docker compose up -d --no-deps --force-recreate lunatv-core
   ```
6. 验证：
   - 站长 Tab 用户表显示「在线/累计设备数」和「互踢次数」；终端表含在线状态列；
   - 在线升级区不再报「无法连接版本源」，能读到 GHCR 上的 tag 列表；
   - 普通账号在新设备上登录，达到 30 台会被拒并在登录页看到提示；admin 不受限。

> 阈值改法：compose 里 `MAX_USER_DEVICES` 改成想要的数字即可，无需重新编译。

## 七、回滚

镜像保留旧 tag，回滚只需把 compose 的 image 改回旧版本并 recreate：

```bash
sudo sed -i "0,/image: .*/s#image: .*#image: ghcr.io/jshmcz/lunatv:5.1.8#" docker-compose.yml
sudo docker compose up -d --no-deps --force-recreate lunatv-core
```
