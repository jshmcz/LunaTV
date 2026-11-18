# GitHub Actions 云端编译方案（推荐）

把去广告增强的编译放到 GitHub 云端做，NAS 只负责拉取镜像运行。彻底避开国内下载慢、NAS 编译环境缺依赖的问题。

## 原理

```
fork 本仓库 → GitHub Actions 云端：拉官方源码 → 打补丁 → 编译 → 推镜像到 GHCR
                                                              ↓
                               NAS：docker pull 镜像 → 重启 core 容器（一条命令）
```

镜像托管在 GitHub Container Registry（ghcr.io），免费、无需自建仓库。

---

## 一次性设置（约 5 分钟）

### 1. Fork 仓库

打开 `https://github.com/laboratorys/LunaTV`，点右上角 **Fork**，fork 到你自己的账号下（比如 `yourname/LunaTV`）。

> **关于 fork 页面上的 "Copy the `dev` branch only" 勾选框**：保持勾选，直接点 Create fork 即可。  
> 这个选项问的是"要不要只复制默认分支 `dev`"（而非官方所有分支），**与版本号无关**。  
> 分支（dev）≠ 版本（5.1.8 tag）：编译源码由 workflow 里填的版本号决定，从官方仓库按 tag 拉取，  
> 你的 fork 只是用来放补丁文件。所以 dev 分支完全不影响编译。

### 2. 上传本目录的文件到你的 fork

把本目录（`github-action/`）里的这些文件，按如下路径上传到**你 fork 的仓库**：

```
你的仓库/
├── .github/workflows/build.yml     ← 云端编译流程
├── apply_patch.sh                  ← 打补丁脚本
├── Dockerfile                      ← 带编译工具链的构建文件
└── patch/
    ├── pcrAdFilter.facade.ts
    ├── heuristicAdFilter.ts
    ├── enhancedAdFilter.ts
    └── optimizedProbe.ts
```

（GitHub 网页版可以直接拖拽上传；或用 git 命令 push。）

**注意**：必须上传到 fork 的**默认分支**（这个仓库是 `dev`）。网页版拖拽默认就传到默认分支。  
传完后到 **Actions** 标签，能看到 "Build LunaTV Enhanced (去广告增强版)" 和 **Run workflow** 按钮，就说明放对了。

### 3. 开启 GHCR 写权限

仓库页面 → **Settings** → 左侧 **Actions** → **General** → 找到 **Workflow permissions** → 选 **Read and write permissions** → Save。

（这一步是让 Actions 有权限把镜像推到 ghcr.io。）

---

## 日常使用

### 编译增强镜像

1. 打开你的仓库 → **Actions** 标签
2. 左侧选 **Build LunaTV Enhanced (去广告增强版)**
3. 点 **Run workflow** → 填入版本号（如 `5.1.8`）→ 绿色按钮运行
4. 等约 5–10 分钟，成功后镜像推送到：


   ```
   ghcr.io/你的用户名/你的仓库名:5.1.8
   ghcr.io/你的用户名/你的仓库名:latest
   ```

### NAS 拉取并切换（一条命令）

在你的 NAS 上执行（把 `yourname/LunaTV` 换成你的实际仓库名）：

```bash
cd /vol1/lunatv
sudo docker pull ghcr.io/yourname/LunaTV:5.1.8
sudo sed -i "0,/image: .*/s#image: .*#image: ghcr.io/yourname/LunaTV:5.1.8#" docker-compose.yml
sudo docker compose up -d --no-deps --force-recreate lunatv-core
```

数据卷、网关、账号、配置全部保留。

---

## 上游升级流程（以后官方发新版）

1. GitHub Actions 里 Run workflow，版本号填新的（如 `5.2.0`）
2. 编译成功后，NAS 上把上面命令里的 `5.1.8` 换成 `5.2.0` 执行

**全程不用下载源码、不用在 NAS 上编译。** 这就是云端方案的核心价值。

---

## 私有仓库怎么办

如果 fork 的仓库设为 private，NAS 拉 ghcr.io 镜像需要先登录：

```bash
# 在 GitHub 生成一个 read:packages 权限的 Personal Access Token
sudo docker login ghcr.io -u 你的用户名 -p YOUR_TOKEN
```

公开仓库则无需登录，直接 pull。

---

## 两种方案对比

|      | NAS 本地构建（auto-upgrade.sh） | GitHub Actions 云端   |
| ---- | ------------------------- | ------------------- |
| 源码下载 | 国内慢、需多策略降级                | 云端秒下                |
| 编译环境 | 需 python/g++/补 Dockerfile | runner 自带           |
| 占用资源 | 占 NAS CPU/内存 10+ 分钟       | 不占 NAS              |
| 升级操作 | 跑一条脚本                     | 网页点一下 + NAS pull    |
| 前提   | 无                         | GitHub 账号 + fork 一次 |
| 离线可用 | ✅ 完全本地                    | ❌ 需 GitHub 在线       |

建议：**两者都保留**。日常用 GitHub Actions 省事；GitHub 不可用时用本地脚本兜底。
