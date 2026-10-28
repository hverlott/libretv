# LibreTV 个人定制版：安卓 Termux 家庭影音与漫画服务

[English](README.en.md) · [安卓部署](ANDROID.md) · [常见问题](FAQ.md) · [本地部署](DEPLOY_LOCAL.md) · [隐私说明](PRIVACY.md)

**hverlott/libretv 是基于 LibreSpark/LibreTV v2.19.7 二次开发的自托管 Web 应用，集成视频搜索与播放、M3U/IPTV 直播、在线及本地漫画阅读、评分补全和局域网访问。** 可以把闲置安卓手机通过 Termux 用作家庭服务端，也支持 Windows 和 Docker 部署；客户端使用浏览器访问。

Android Termux home media server · self-hosted video search · IPTV player · manga reader

本项目由 [hverlott](https://github.com/hverlott) 维护，采用 [AGPL-3.0-or-later](LICENSE)。这是独立修改版，与[上游 LibreTV](https://github.com/LibreSpark/LibreTV) 的功能和发布版本分别维护。

## 它能解决什么问题？

- **闲置安卓手机再利用**：手机运行服务，同一局域网的电脑、平板、电视浏览器访问；部署完成后，电脑无需持续开机。
- **家庭浏览器影音入口**：把自行配置的视频接口与 M3U 直播列表放到同一界面，支持搜索、播放、选集和换源。
- **漫画阅读**：支持 MangaDex、再漫画，以及自己提供的图片目录、ZIP、CBZ、TAR.GZ 本地漫画。
- **内容整理**：可选 TMDB / 豆瓣评分补全、内容过滤、历史与收藏。

本项目提供软件和资源接口接入能力，不是影视内容托管站。第三方接口、作品和频道的可用性与授权由相应提供方决定；接口数量不等于独立片库数量。

## 先选哪个分支？

| 分支 | 用途 | 获取方式 |
|---|---|---|
| [`main`](https://github.com/hverlott/libretv/tree/main) | 默认分支，项目通用功能与说明 | `git clone https://github.com/hverlott/libretv.git` |
| [`android-mobile`](https://github.com/hverlott/libretv/tree/android-mobile) | 安卓与手机浏览器优化：底部导航、全屏设置、漫画阅读控制、Termux 守护脚本 | `git clone --branch android-mobile https://github.com/hverlott/libretv.git` |

两个分支独立更新。使用手机优化功能请明确选择 `android-mobile`；旧 Release 不一定包含该分支最新改动。

## 安卓手机如何部署 LibreTV？

采用**电脑构建、手机运行**的方式。安卓侧安装 Termux 和 Node.js，不需要 root 或刷机；手机运行打包后的 JavaScript，避免在 Termux 中直接构建 Next.js 时的平台原生依赖兼容问题。

在电脑上准备源码与依赖：

```bash
git clone --branch android-mobile https://github.com/hverlott/libretv.git
cd libretv
npm install
cp .env.example .env
# 编辑 .env，设置自己的 PASSWORD 后再启动或打包。
npm run build:standalone
npm run pack:standalone
```

然后按 [ANDROID.md 的部署说明](ANDROID.md) 将运行包传到手机，在 Termux 中配置 `.env` 并启动。`npm run deploy:android` 是可选的 ADB 辅助脚本，需要 USB 调试授权，以及允许 `run-as com.termux` 的安装版本；不满足条件时需手动复制运行包。不要将普通 Termux 安装都视为支持 `run-as`。

`android-mobile` 提供单实例启动脚本与崩溃退避重启。长期运行还取决于手机厂商的后台管理、电源、网络及 Termux:Boot 配置；并不保证所有手机都能无干预常驻。

## Windows、Docker 和本地开发

在电脑上安装 Node.js 与 npm 后：

```bash
git clone https://github.com/hverlott/libretv.git
cd libretv
npm install
cp .env.example .env
# 编辑 .env，修改 PASSWORD。
npm run dev
# 浏览器打开 http://localhost:8080
```

生产运行：`npm run build && npm start`。Windows 也可使用仓库中的 `启动系统.bat`、`停止系统.bat` 和 `查看状态.bat`，详见 [本地部署与控制](DEPLOY_LOCAL.md)。

Docker 用户可以从当前源码构建：配置 `.env` 后执行 `docker compose up -d --build`。仓库 Compose 的默认镜像名指向上游；直接拉取上游镜像不会自动包含本修改版功能。自定义源、本地漫画目录和持久化目录需按自己的部署配置。

内存、功耗、启动时间和可播放码率取决于设备、版本、网络及来源，本仓库不提供跨设备性能承诺。

## 主要功能与实现

| 功能 | 能力与边界 | 文档或实现入口 |
|---|---|---|
| 视频搜索与播放 | 多接口搜索、选集、换源；ArtPlayer + hls.js | [播放器页面](src/app/watch) |
| M3U / IPTV 直播 | 直播列表接入、节目单及可用性探测；频道可能失效 | [直播页面](src/app/live) |
| 在线漫画 | MangaDex + 再漫画，分类浏览与章节阅读 | [漫画页面](src/app/manga)、[漫画来源说明](MANGA_SOURCES.md) |
| 本地漫画 | 图片目录与压缩包，需服务端能读取指定路径 | `LOCAL_MANGA_DIR`、[常见问题](FAQ.md) |
| 手机阅读器 | 安卓分支提供章节搜索、单页/条漫切换、模式记忆和图片重试 | [安卓分支说明](https://github.com/hverlott/libretv/blob/android-mobile/ANDROID.md) |
| 评分补全 | 可选 TMDB / 豆瓣，匹配与缓存；不保证每项都有评分 | `RATING_PROVIDER` |
| 局域网与系统管理 | 绑定地址配置，系统页展示运行信息 | [系统页面](src/app/system) |
| 数据与隐私 | 浏览器保存历史、收藏及设置，部分缓存在服务端；第三方请求依功能而定 | [PRIVACY.md](PRIVACY.md) |

技术栈：Next.js App Router、React、TypeScript、Tailwind CSS、ArtPlayer、hls.js。依赖与命令以 [package.json](package.json) 为准。

## 常用配置

完整选项见 [.env.example](.env.example)。下列为用途说明，不含个人配置：

| 配置 | 用途 |
|---|---|
| `PASSWORD` | 必填访问密码；修改示例默认值，不要上传 `.env` |
| `LAN_ACCESS` / `BIND_HOST` | 由启动方式决定监听地址；局域网部署需检查实际绑定与防火墙 |
| `DEFAULT_SOURCES` | 部署者预置的视频接口 |
| `DEFAULT_LIVE_SOURCES` | 部署者预置的 M3U 直播列表 |
| `LOCAL_MANGA_DIR` | 服务端可读的本地漫画目录，留空则不启用 |
| `RATING_PROVIDER` | `auto` / `tmdb` / `douban` / `none` |
| `TMDB_API_KEY` | 使用 TMDB 评分时的可选密钥 |

## 常见问题速答

**需要买 NAS 或让电脑一直开着吗？** 不需要。部署到安卓后，手机承担服务端工作；首次构建和后续源码更新通常仍在电脑完成。

**手机、电视和平板会自动同步观看记录吗？** 不会。历史、收藏和偏好主要存储在各浏览器，换设备或访问地址不会自动共享。详见 [FAQ](FAQ.md)。

**为什么搜索或直播有时不可用？** 上游接口可能超时、限流、失效或存在地区限制。可尝试其他已配置来源，不能据此保证所有资源可播放。

**这是 LibreTV 官方安卓 App 吗？** 不是。这是独立修改版的 Web 服务，可部署到 Termux；手机浏览器界面不是原生 APK。

## 开发、反馈与项目入口

```bash
npm test
npm run typecheck
npm run lint
```

部分端到端测试需要运行中的服务及相应浏览器，具体命令见 [package.json](package.json)。

- [源代码与版本分支](https://github.com/hverlott/libretv)
- [发布记录](https://github.com/hverlott/libretv/releases)：请核对发布版本及所含功能
- [问题反馈](https://github.com/hverlott/libretv/issues)：说明分支、部署方式、复现步骤，日志请先去除密码、密钥和私人地址
- [English overview](README.en.md) · [完整 FAQ](FAQ.md) · [机器可读文档索引](llms.txt)

## 致谢与许可

感谢 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 及其贡献者提供原始项目。本仓库在其基础上扩展漫画、评分、导航和部署能力；原始代码的著作权归对应作者所有。

代码按 [AGPL-3.0-or-later](LICENSE) 发布，修改与再分发请遵循许可证。软件许可证不授予第三方影视、漫画或直播内容的使用权。
