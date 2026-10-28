# LibreTV Custom: Android Termux Home Media Server and Manga Reader

[中文说明](README.md) · [Android deployment (Chinese)](ANDROID.md) · [FAQ](FAQ.md)

**hverlott/libretv is a self-hosted web application based on LibreSpark/LibreTV v2.19.7.** It combines video search and playback, M3U/IPTV live playlists, online and local manga reading, optional rating enrichment, and local-network access. An Android phone running Termux can act as the server; clients connect using a web browser. Windows and Docker deployment are also supported.

Maintained by [hverlott](https://github.com/hverlott), this is an independent modification of [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV), licensed under [AGPL-3.0-or-later](LICENSE).

## Choose a branch

- [`main`](https://github.com/hverlott/libretv/tree/main): default branch and general project documentation.
- [`android-mobile`](https://github.com/hverlott/libretv/tree/android-mobile): mobile navigation, full-screen settings, manga reader controls, and Termux service supervision. Select this branch for the phone-focused experience.

Branches are maintained separately. Older releases may not include the latest Android branch changes.

## What can it do?

| Capability | Details |
|---|---|
| Video | Search configured provider APIs, play video, select episodes, and switch sources |
| Live TV | Import M3U/IPTV lists, view supported programme data, and probe stream availability |
| Online manga | Browse MangaDex and the Chinese-language 再漫画 provider |
| Local comics | Read your own image folders, ZIP, CBZ, and TAR.GZ archives from a server-readable directory |
| Mobile reading | Android branch: chapter search, single-page/webtoon modes, saved mode preference, image retry |
| Ratings | Optional TMDB or Douban enrichment; coverage and matching are not guaranteed |
| Home network | Browser access from devices on the same LAN, subject to binding and firewall settings |

The application connects to configured third-party sources. It does not host a guaranteed catalogue, and it does not grant rights to third-party content. Provider availability varies.

## Android deployment

Build on a computer and run the standalone JavaScript package in Termux. Root access and a custom Android ROM are not required. This avoids building Next.js native toolchain dependencies directly in Termux.

```bash
git clone --branch android-mobile https://github.com/hverlott/libretv.git
cd libretv
npm install
cp .env.example .env
# Edit .env and replace PASSWORD before running or packaging.
npm run build:standalone
npm run pack:standalone
```

Copy the package to the phone, configure its `.env`, and follow [ANDROID.md](ANDROID.md). The optional `deploy:android` helper requires ADB authorization and a Termux build that permits `run-as com.termux`. Other installations require a manual transfer. Always preserve the target device's configuration and data during updates.

The Android branch includes a single-instance launcher and crash-restart backoff. Background operation depends on Android vendor restrictions, power, connectivity, and optional Termux:Boot setup. Device-independent power or performance figures are not promised.

## Local development and Docker

After cloning the chosen branch and configuring `.env`:

```bash
npm install
npm run dev
# http://localhost:8080
```

For production, use `npm run build && npm start`. To build the custom source with Docker, configure `.env` and run `docker compose up -d --build`. The existing Compose default image name points to upstream; pulling an upstream image does not include these custom changes. Configure directory mounts and environment variables for your deployment.

## Configuration and data

See [.env.example](.env.example), [local deployment](DEPLOY_LOCAL.md), and [privacy notes](PRIVACY.md). `PASSWORD` is required. `LOCAL_MANGA_DIR` enables a readable local comic directory; `RATING_PROVIDER=none` disables rating enrichment. Keep credentials out of Git.

History, favourites, and preferences are primarily stored in each browser. They do not automatically synchronize between devices or URL origins. Server-side caches and downloaded files are separate from browser state. External requests depend on enabled providers and features; the proxy is not an anonymity guarantee.

## Development and support

```bash
npm test
npm run typecheck
npm run lint
```

[Report an issue](https://github.com/hverlott/libretv/issues) with the branch, deployment method, and reproduction steps. Remove credentials and private addresses from logs. See [releases](https://github.com/hverlott/libretv/releases), the [FAQ](FAQ.md), and the [documentation index](llms.txt).

Thanks to the upstream LibreTV authors and contributors. See [LICENSE](LICENSE) for the software terms; third-party media rights are separate.
