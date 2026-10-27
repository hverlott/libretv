/**
 * 部署者通过 DEFAULT_ADULT_FILTER 环境变量指定的「成人内容过滤」默认值。
 *
 * - `false`（或 0 / off / no）：默认关闭过滤——搜索与热门列表不过滤成人分类，
 *   标记为成人内容的源也会自动勾选。适合自建自用、只在本机/局域网使用的部署。
 * - `true`（或 1 / on / yes）：保持出厂默认（开启过滤）。
 *
 * 未配置时返回 undefined，沿用内置默认 true（过滤开启）。
 * 语义与 DEFAULT_RECOMMEND_SOURCE / DEFAULT_IMAGE_MODE 一致：仅作为**默认值**，
 * 用户在设置里主动改过之后，以用户的选择为准。
 */
export function getEnvAdultFilter(): boolean | undefined {
  const raw = process.env.DEFAULT_ADULT_FILTER?.trim().toLowerCase();
  if (!raw) return undefined;
  if (['false', '0', 'off', 'no'].includes(raw)) return false;
  if (['true', '1', 'on', 'yes'].includes(raw)) return true;
  console.warn(
    '[LibreTV] DEFAULT_ADULT_FILTER 取值无效，已忽略（可选 true / false）：',
    raw
  );
  return undefined;
}
