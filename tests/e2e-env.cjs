/**
 * e2e 公共环境读取。
 *
 * ## 为什么需要它
 *
 * 之前每个 e2e 都写 `process.env.PASSWORD || 'libretv'`——这个默认值是**猜的**。
 * 项目 .env 里的真实密码一旦不是 libretv（用户改了密码就会这样），
 * 登录接口返回 401，而有些用例本身不校验"登录成功"，于是一路静默跑空、
 * 结果仍然全绿。这类假阳性比失败更危险：它会让"验证通过"变成一句空话。
 *
 * 现在的规则：环境变量 > .env 里的真实配置；两者都没有就直接报错退出，
 * 绝不拿一个猜的值继续跑。
 */

const { readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 从 .env 的生效行里取某个键（跳过被注释掉的行） */
function envValue(key) {
  try {
    const text = readFileSync(path.join(ROOT, '.env'), 'utf8');
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(re);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* .env 不存在时交给调用方处理 */
  }
  return '';
}

function resolvePassword() {
  const fromEnv = (process.env.PASSWORD || '').trim();
  if (fromEnv) return fromEnv;
  return envValue('PASSWORD');
}

/** 取密码；拿不到就明确失败，不要用默认值把问题盖住 */
function requirePassword() {
  const pw = resolvePassword();
  if (!pw) {
    console.error(
      '[-] 未找到访问密码：请在项目 .env 里设置 PASSWORD，或用 `PASSWORD=xxx node tests/xxx.cjs` 运行。'
    );
    process.exit(1);
  }
  return pw;
}

module.exports = { ROOT, envValue, resolvePassword, requirePassword };
