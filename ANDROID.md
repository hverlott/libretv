# 在安卓手机上运行 LibreTV（Termux）

不需要刷机、不需要 root。手机只是一个跑 `node server.js` 的普通 App。

> 本文档中的 IP、MAC、SSID 均为示例值（`192.168.1.x` / `aa:bb:cc:dd:ee:ff` / `MyWiFi`），
> 照做时请替换成你自己网络里的实际值。


## 架构：手机当唯一服务器

```
        ┌─────────────┐
        │  手机（服务器）│  ← 唯一跑服务的地方，24h 插电
        │  Termux+Node │
        └──────┬──────┘
               │ 局域网 HTTP :8080
   ┌───────────┼───────────┬──────────┐
电脑浏览器   平板浏览器   电视浏览器   手机浏览器
```

- **不需要**在电脑上再跑一份服务（两份会各存一套缓存和下载，反而乱）
- 电脑上的 `启动系统.bat`、`停止系统.bat`、桌面客户端都可以不用了，留着不影响
- **电脑不需要一直开着**，手机开着就行

### ⚠️ IP 必须固定（已完成）

手机的 IP 由路由器 DHCP 分配，**一变就会出问题**：书签失效，而且浏览器里存的设置、历史、
自定义源会因为换了 origin 全部重置。**

当前状态：**已固定为静态 IP `192.168.1.100`**（手机上 WiFi 高级设置里设的，
`ip addr` 显示 `valid_lft forever`）。

如果以后要改回 DHCP 或用路由器绑定，两种方式：

1. **路由器里绑定（推荐）**：登录 `192.168.1.1` → 高级设置 → DHCP 静态 IP 绑定，
   把**手机的 MAC** `aa:bb:cc:dd:ee:ff` 绑到 `192.168.1.100`
   > 注意别拿错 MAC：`44:df:65:e7:cb:73` 是路由器（BSSID）的，不是手机的
2. **手机上设静态 IP**：长按 WiFi `MyWiFi` → 修改网络 → 高级 → IP 设置改「静态」，
   IP 填 `192.168.1.100`（避开 DHCP 池，一般池子是 .100–.199），网关 `192.168.1.1`

### 换地址后怎么保留原来的配置

浏览器数据按 origin 隔离，`localhost:8080` 和 `192.168.1.100:8080` 是两套。
电脑旧地址里如果有自定义源、筛选设置、收藏：

1. 在旧地址打开 → 设置面板 → 「配置导入导出」→ **导出**
2. 打开新地址 → 同一位置 → **导入**

### 数据都落在哪

| 数据 | 位置 |
|---|---|
| 服务端批量下载的影片 | 手机 app 私有目录 `~/libretv/downloads/`（可用 285GB） |
| 评分缓存、漫画索引 | 手机 `~/libretv/.runtime/` |
| 浏览器端历史、收藏、设置 | 各自设备的浏览器本地（不共享） |

> 换句话说：**换设备看，进度/收藏不跟着走**。服务端只有缓存和下载任务是共享的。

### 单点风险

手机就是唯一入口，它挂了全家都不能看：

- 手机没电 / 断 WiFi / 被系统冻结 → 打不开
- 重启后如果没给 Termux:Boot 自启动权限 → 需要打开 Termux 敲 `lb`
- 手机长时间插电 → 建议开「充电优化（限充 80%）」保护电池

## 当前已部署情况

| 项 | 值 |
|---|---|
| 设备 | 某 Android 14 手机，Android 14 / SDK 34，arm64-v8a，15.5GB RAM |
| 访问地址 | `http://192.168.1.100:8080`（**已设静态 IP**，不会变） |
| 网络 | WiFi 6 / 5GHz (5220MHz) / 协商速率 720Mbps / 信号 -48dBm |
| 访问密码 | 见手机上的 `.env` 的 `PASSWORD` |
| Termux | 0.118.3（GitHub debug 版；**不是** F-Droid 版，两者签名不同不能混装） |
| Termux:Boot | 0.8.1（开机自启） |
| Node.js | 24.22.1（Termux 官方源 `nodejs-lts`） |
| 内存占用 | 100–140MB（单进程，无原生模块） |
| 堆上限 | 1GB（`--max-old-space-size=1024`，实测远用不到） |
| 屏幕常亮 | **不需要**（唤醒锁足够，可正常息屏） |
| 空闲后首包 | 27–61ms |
| 各页面响应 | 35–137ms |

## 文件都在哪

```
/data/data/com.termux/files/home/
├── libretv/                    # 程序本体（standalone 产物 + .env）
├── start-server.sh             # 启动脚本（带唤醒锁 + 崩溃重启）
├── .termux/boot/000-libretv.sh # 开机自启（Termux:Boot 调用）
└── .termux/../usr/bin/lb       # 快捷命令

$PREFIX/tmp/lb.log              # 运行日志
$PREFIX/tmp/lb-boot.log         # 开机自启日志
```

## 日常操作（在 Termux 里敲）

```sh
lb                      # 启动（崩溃自动重启、自动拿唤醒锁）
lbr                     # 重启（改完 .env 用它，3~4 秒恢复，不用重启手机）
tail -f $PREFIX/tmp/lb-boot.log   # 看日志
```

**注意进程名是 `next-server`，不是 `server.js`** —— Next 会改进程名，
用 `pkill -f server.js` 杀不掉任何东西。

彻底停止（连同自动重启的循环一起停）：

```sh
pkill -f start-server.sh   # 先停循环，否则杀掉 node 会被立刻拉起
pkill -9 -f next-server    # 再停 node
```

**改配置后必须重启进程才生效**：`.env` 只在进程启动时读进 `process.env`，改文件不影响已运行的进程。

- 改密码 / 端口 → `lbr`
- 改完想全量重来 → 重启手机（Termux:Boot 会自动拉起）

退出前台但保持后台运行：按 `Ctrl+C` 会停服务；想让它继续跑就按 `Home` 键回桌面，别关 Termux。

## 从电脑更新手机上的版本

```bash
npm run build:standalone   # 生成 standalone 产物
npm run pack:standalone    # 组装成可拷贝目录 + start.sh
npm run deploy:android     # 推到手机（自动保留手机上原有的 .env）
```

`deploy:android` 干的事：打 tgz → `adb push` 到 `/data/local/tmp` → 用 `run-as com.termux`
以 Termux 身份解压到 `~/libretv`（先备份 `.env` 再还原）。

推送完成后**必须重启手机**才生效。原因见下面「已知限制」第一条。

## 手机系统设置（已完成 ✅）

这几项决定「息屏后还能不能用」。当前配置已实测：**手机不亮屏、后台不手动干预，
服务仍能随时响应**（息屏 2 分钟连续探测 200，77–137ms）。

| 设置 | 状态 | 位置 |
|---|---|---|
| 电池优化白名单 | ✅ | `cmd deviceidle whitelist` 里有 `com.termux` |
| 允许自启动 | ✅ | 设置 → 应用 → 自启动管理（Termux + Termux:Boot） |
| 锁定后台 | ✅ | 最近任务 → Termux 卡片下拉 → 锁图标 |
| 关闭睡眠待机优化 | ✅ | 设置 → 电池 → 更多设置 → 睡眠待机优化 |

> 换新手机重装时，这 4 项仍要手动做一遍 —— ColorOS 没给第三方接口。
> 漏开「自启动」的话，重启手机后服务不会自己起来，需要手动打开 Termux 敲 `lb`。

## 长期运行优化

7×24 挂着，有三件事会随时间恶化。处理逻辑都写在 `scripts/android/start-server.sh`，
由 `npm run deploy:android` 自动同步 —— 不用再手工改手机上的脚本。

| 问题 | 表现 | 处理 |
|---|---|---|
| **日志无限增长** | 早期实测约 200 KB/小时，一年累积 1–2 GB | 启动时检查，超过 5 MB 清空。用 `: > 文件` 而不是删除（进程持有 fd，删了日志就不再落盘） |
| **Node 堆无上限** | 长期运行 RSS 缓慢上涨，可能触发系统杀进程 | `--max-old-space-size=1024`（实测 RSS 100–140 MB，1 GB 绰绰有余） |
| **双实例抢端口** | 手动 `lb` 时若已有实例在跑，会反复 `EADDRINUSE` 刷屏 | 启动前探一次 `127.0.0.1:$PORT`，有响应就直接退出 |

**唤醒锁不能省。** 去掉后息屏进入 Doze，网络请求会被推迟到系统维护窗口 ——
表现就是「偶尔第一次打开转圈几十秒」，这也是之前踩过的坑。

## 已知限制

1. **进程模型取决于「谁启动的」**，这两种差别很大：

   | 启动方式 | 进程身份 | `ps` 可见 | 能否 kill | 谁管 |
   |---|---|---|---|---|
   | `adb run-as` 手动起 | `runas_app` 域的孤儿 | ❌ | ❌ | 没人管，只能重启手机清掉 |
   | **Termux:Boot / Termux 内 `lb`（当前）** | `untrusted_app_27`，Termux 的子进程 | ✅ 名字是 `next-server` | ✅ `kill -9` 后循环自动拉起 | 受 AMS 管理 |

   也就是说现在改配置、更新程序都**不用重启手机**了（`lbr` 即可）。
   代价是它也会被 ColorOS 的「清理后台」杀掉 —— 所以「锁定后台」+「电池白名单」这两项是真起作用的关键。
2. **存储权限已开通**（在 Termux 里运行过 `termux-setup-storage` 并点了允许）。
   本地漫画库已指向 `/sdcard/Manga`，往这个目录里放作品/压缩包即可。

   > 挑人的一点：**用 `adb run-as com.termux` 是读不了 `/sdcard` 的**（`Permission denied`），
   > 因为 `run-as` 跑在受限的 `runas_app` SELinux 域。但服务进程属于 `untrusted_app_27`
   > （Termux app 的子进程），能正常访问。所以「用 adb 测不出来」≠「服务用不了」，
   > 要验证得让服务自己去读（例如 `curl /api/manga/local` 看返回）。
3. **`.env` 里的 Windows 路径已经清掉**（`LOCAL_MANGA_DIR` / `DOWNLOAD_DIR` 置空）。手机上要启用本地漫画库，把 `LOCAL_MANGA_DIR` 设成 Termux 能读的路径（如 `/data/data/com.termux/files/home/Manga`）。
4. **没有装 Termux:API**。它只用于访问摄像头、剪贴板等系统能力，跑服务不需要。

## 踩过的坑（重新部署时会再遇到）

- **`adb install` 报 `Failure [-99]`**：ColorOS 拦截了流式安装。改成
  `adb push x.apk /data/local/tmp/ && adb shell pm install -r /data/local/tmp/x.apk`。
- **`node` 报 `cannot locate symbol`**：bootstrap 里的 `libc++`(27c) 和 `openssl` 太旧，而 `nodejs-lts` 是新的。
  必须 `apt full-upgrade`；中途会卡在 `openssl.cnf` 的交互确认，要加
  `-o Dpkg::Options::=--force-confnew -o Dpkg::Options::=--force-confdef`。
- **Git Bash 会把 `/data/local/tmp` 转成 Windows 路径**：所有 adb 命令前加 `export MSYS_NO_PATHCONV=1`。
- **`curl` 下载 GitHub release 报 `CONNECT tunnel failed, response 502`**：本机 `HTTPS_PROXY` 挂了，
  加 `--noproxy '*'` 直连即可。
- **f-droid.org 不通**，Termux 的包要从 `packages-cf.termux.dev` 拿（这条通）。
