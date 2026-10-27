import type { MatchCandidate } from './match';
import type { RatingProviderId, RatingQuery } from './types';

/**
 * 上游返回 403/429/401 等「被拒绝」信号时抛出，
 * 编排层据此进入冷却，而不是当成普通网络错误重试。
 */
export class ProviderRejected extends Error {
  readonly status: number;
  constructor(status: number, provider: RatingProviderId) {
    super(`${provider} 拒绝请求 (${status})`);
    this.name = 'ProviderRejected';
    this.status = status;
  }
}

/** 上游不可用（未配置 key、域名不可达等） */
export class ProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailable';
  }
}

export interface RatingProvider {
  readonly id: RatingProviderId;
  /** 是否已具备运行条件（如 TMDB 需要 API key） */
  available(): boolean;
  /** 返回候选条目；候选可能为空数组（搜不到），不应抛错 */
  search(query: RatingQuery): Promise<MatchCandidate[]>;
  /** 条目详情页地址（用于卡片跳转） */
  subjectUrl(id: string): string | undefined;
}
