#!/usr/bin/env node
/**
 * 把 standalone 产物推送到安卓手机（Termux）。
 *
 * 前提：
 *   1. 手机已用 USB 连上且开启 USB 调试（`adb devices` 能看到 device）
 *   2. 已装 Termux，且跑过一次（bootstrap 解开）
 *   3. 已执行 `npm run build:standalone && npm run pack:standalone`
 *
 * 为什么不用 `adb push` 直接推到目标目录：Termux 的私有目录（/data/data/com.termux）
 * 只有它自己的 uid 能访问，adb 的 shell 用户没有写权限。唯一可行的通路是
 * `adb push` 到 /data/local/tmp，再用 `run-as com.termux` 以 Termux 身份解压。
 *
 * 注意：替换正在运行的服务目录后，必须重启手机才生效。
 * 用 run-as 派生的 node 进程脱离 ActivityManager 管理，force-stop / pkill 都杀不掉
 * （详见 ANDROID.md 的「已知限制」）。
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(ROOT, '.runtime', 'standalone-package');
const TMP_TGZ = join(ROOT, '.runtime', 'libretv-package.tar.gz');

const ADB = [
  join(ROOT, '.runtime', 'tools', 'platform-tools', 'adb.exe'),
  'adb',
].find((p) => p === 'adb' || existsSync(p));

// 目标目录名可覆盖，方便在不影响运行中服务的前提下验证脚本本身
const args = process.argv.slice(2);
const targetIdx = args.indexOf('--dir');
const TARGET_NAME = targetIdx >= 0 ? args[targetIdx + 1] : 'libretv';
if (!/^[\w.-]+$/.test(TARGET_NAME)) {
  console.error('[-] --dir 只接受字母数字和 ._-');
  process.exit(1);
}

const TERMUX = '/data/data/com.termux/files';
const DEST = `${TERMUX}/home/${TARGET_NAME}`;

function run(cmd, argv, opts = {}) {
  // cwd 固定到项目根：传给 tar 的路径必须是相对路径。
  // Windows 上 Git 自带的 GNU tar 会把 `C:\...` 里的 `C:` 当成远程主机名
  // （tar 的 `-f host:path` 语法），报 "Cannot connect to C: resolve failed"。
  const r = spawnSync(cmd, argv, { encoding: 'utf8', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} 失败:\n${r.stdout || ''}${r.stderr || ''}`);
  }
  return (r.stdout || '').trim();
}

function step(msg) {
  console.log(`[*] ${msg}`);
}

// —— 1. 环境检查 ——
if (!ADB) {
  console.error('[-] 找不到 adb。Windows 可下载 platform-tools 放到 .runtime/tools/，');
  console.error('    或把 adb 加进 PATH（见 ANDROID.md）。');
  process.exit(1);
}
if (!existsSync(PKG_DIR)) {
  console.error('[-] 产物目录不存在：' + PKG_DIR);
  console.error('    先执行：npm run build:standalone && npm run pack:standalone');
  process.exit(1);
}

let devices;
try {
  devices = run(ADB, ['devices']);
} catch (e) {
  console.error('[-] adb 执行失败：' + e.message);
  process.exit(1);
}
const online = devices
  .split('\n')
  .slice(1)
  .map((l) => l.trim().split(/\s+/))
  .filter((parts) => parts[1] === 'device');
if (online.length === 0) {
  console.error('[-] 没有已授权的设备。检查：USB 线是否支持数据传输、');
  console.error('    手机是否点了「允许 USB 调试」、`adb devices` 里是否有 unauthorized。');
  process.exit(1);
}
step(`设备已连接：${online[0][0]}`);

try {
  run(ADB, ['shell', 'run-as', 'com.termux', 'id']);
} catch {
  console.error('[-] 无法以 com.termux 身份执行（run-as 失败）。');
  console.error('    可能原因：装的是 Google Play 版 Termux（非 debuggable）。');
  console.error('    必须用 GitHub / F-Droid 版。');
  process.exit(1);
}
step('Termux 可访问');

// —— 2. 打包 ——
step('打包产物…');
mkdirSync(dirname(TMP_TGZ), { recursive: true });
rmSync(TMP_TGZ, { force: true });
// 相对路径：GNU tar 会把绝对路径里的盘符当成远程主机（见 run() 的注释）
run('tar', ['-czf', '.runtime/libretv-package.tar.gz', '-C', '.runtime/standalone-package', '.']);
const sizeMB = (statSync(TMP_TGZ).size / 1048576).toFixed(1);
step(`包已生成：${sizeMB} MB`);

// —— 3. 推送 ——
step('推送到设备临时目录…');
run(ADB, ['push', '.runtime/libretv-package.tar.gz', '/data/local/tmp/libretv-package.tar.gz']);

// —— 4. 解压（保留手机上的 .env）——
// .env 里有手机侧的配置（密码、端口、清空过的 Windows 路径），不能拿电脑上的覆盖掉
//
// 为什么把脚本写成设备上的文件、而不是一行 `sh -c "..."` 传进去：
// adb shell 的整条命令还会被设备端的外层 sh 再解析一次，双引号里的 `$D` 会被
// 外层 shell 先展开成空字符串——结果 `rm -rf ""`、`cp /.env` 全错，而且不报错。
// 落成文件就只有一层解析。
const DEPLOY_SH = `${TERMUX}/home/.deploy-libretv.sh`;
const script = [
  '#!/data/data/com.termux/files/usr/bin/sh',
  'set -e',
  `export LD_LIBRARY_PATH=${TERMUX}/usr/lib`,
  `export PATH=${TERMUX}/usr/bin:$PATH`,
  `D=${DEST}`,
  `B=${TERMUX}/home/.env.saved`,
  'if [ -f "$D/.env" ]; then cp "$D/.env" "$B"; fi',
  'rm -rf "$D"',
  'mkdir -p "$D"',
  'cd "$D"',
  'tar -xzf -',
  'if [ -f "$B" ]; then cp "$B" "$D/.env"; rm -f "$B"; fi',
  'echo DEPLOY_OK',
  '',
].join('\n');

step('写入设备端解压脚本…');
await new Promise((res, rej) => {
  const p = spawn(ADB, ['shell', `run-as com.termux sh -c "cat > ${DEPLOY_SH}"`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => (code === 0 ? res() : rej(new Error(`写脚本失败:\n${err}`))));
  p.stdin.end(script);
});

step(`解压到 ${DEST} …`);
// 用「设备端 cat 管道」而不是把 tgz 从电脑喂进 adb 的 stdin：
// adb shell 会分配 PTY，PTY 要做 CR/LF 转换和特殊字节处理，二进制包会被吃掉
// （表现为 gzip: unexpected end of file）。cat 在设备本地读文件，数据不经过 PTY。
await new Promise((res, rej) => {
  const p = spawn(
    ADB,
    ['shell', `cat /data/local/tmp/libretv-package.tar.gz | run-as com.termux sh ${DEPLOY_SH}`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => {
    if (code === 0 && out.includes('DEPLOY_OK')) {
      console.log('[+] 解压完成');
      res();
    } else {
      rej(new Error(`解压失败（exit ${code}）:\n${out}`));
    }
  });
});

// —— 4.5 同步启动脚本 ——
// 把仓库里的启动脚本推到手机，让「唤醒锁 / 日志轮转 / 崩溃重启 / 防双实例」这些逻辑
// 跟着版本走，不用再手工改手机。只在实际部署时做 —— 旁路目录测试不该动真实的自启入口。
if (TARGET_NAME === 'libretv') {
  step('同步启动脚本…');
  const ANDROID_FILES = [
    { src: 'scripts/android/start-server.sh', dest: `${TERMUX}/home/start-server.sh` },
    { src: 'scripts/android/boot.sh', dest: `${TERMUX}/home/.termux/boot/000-libretv.sh` },
  ];
  run(ADB, ['shell', `run-as com.termux mkdir -p ${TERMUX}/home/.termux/boot`]);
  for (const f of ANDROID_FILES) {
    if (!existsSync(resolve(ROOT, f.src))) {
      console.log(`  [!] 本地缺失，跳过: ${f.src}`);
      continue;
    }
    run(ADB, ['push', f.src, '/data/local/tmp/.lv-sync.sh']);
    run(ADB, ['shell', `run-as com.termux cp /data/local/tmp/.lv-sync.sh ${f.dest}`]);
    run(ADB, ['shell', `run-as com.termux chmod 755 ${f.dest}`]);
    console.log(`  ✓ ${f.dest}`);
  }
  run(ADB, ['shell', 'rm -f /data/local/tmp/.lv-sync.sh']);
} else {
  step('旁路模式，跳过启动脚本同步');
}

// —— 5. 结果 ——
const count = run(ADB, ['shell', `run-as com.termux ls ${DEST}`]).split('\n').length;
step(`完成：${count} 个顶层条目`);

if (TARGET_NAME === 'libretv') {
  console.log('');
  console.log('[!] 现在必须重启手机才生效。');
  console.log('    正在运行的 node 进程由 run-as 派生，不在 ActivityManager 管理范围内，');
  console.log('    pkill / am force-stop 都杀不掉它。');
  console.log('    重启后由 Termux:Boot 自动拉起（需已开启 Termux:Boot 的自启动权限），');
  console.log('    或手动打开 Termux 输入 `lb`。');
} else {
  console.log(`[*] 只是部署到 ${TARGET_NAME}，未影响正在运行的服务。`);
}
