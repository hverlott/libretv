import { describe, it, expect, beforeEach } from 'vitest';
import {
  enqueueBatch,
  getSnapshot,
  loadQueue,
  clearFinished,
  cancelBatch,
  removeBatch,
} from './download-queue';

/**
 * 队列的内存态是权威：正在下载的任务只存在于内存中。
 * 回归点：loadQueue 若每次都从磁盘重载，会把内存里的任务整个冲掉，
 * 表现为「提交 3 集，只下了第 1 集，其余永远停在排队中」。
 */
describe('download-queue · 内存态权威', () => {
  beforeEach(async () => {
    // 清理上一轮遗留的批次
    await loadQueue();
    for (const b of getSnapshot().batches) {
      cancelBatch(b.id);
      removeBatch(b.id);
    }
    clearFinished();
  });

  it('重复 loadQueue 不会冲掉内存中的任务', async () => {
    const result = enqueueBatch('测试批次', [
      { title: '影片A', episode: 1, totalEpisodes: 1, url: 'https://example.com/a.m3u8' },
      { title: '影片B', episode: 1, totalEpisodes: 1, url: 'https://example.com/b.m3u8' },
      { title: '影片C', episode: 1, totalEpisodes: 1, url: 'https://example.com/c.m3u8' },
    ]);
    expect(result.taskIds).toHaveLength(3);

    // 模拟前端轮询：反复调 loadQueue（这是 bug 的触发路径）
    await loadQueue();
    await loadQueue();
    await loadQueue();

    const snapshot = getSnapshot();
    const tasks = snapshot.tasks.filter((t) => t.batchId === result.batchId);
    expect(tasks).toHaveLength(3);
  });

  it('enqueueBatch 返回批次 ID 与任务 ID 列表', () => {
    const result = enqueueBatch('批次2', [
      { title: '影片D', episode: 1, totalEpisodes: 1, url: 'https://example.com/d.m3u8' },
    ]);
    expect(result.batchId).toBeTruthy();
    expect(result.taskIds).toHaveLength(1);
    expect(result.truncated).toBe(0);

    const batch = getSnapshot().batches.find((b) => b.id === result.batchId);
    expect(batch?.label).toBe('批次2');
    expect(batch?.taskIds).toHaveLength(1);
  });

  it('任务入队后立即被调度器拉起（状态为 running 或 queued）', () => {
    const result = enqueueBatch('批次3', [
      { title: '影片E', episode: 1, totalEpisodes: 1, url: 'https://example.com/e.m3u8' },
    ]);
    const task = getSnapshot().tasks.find((t) => t.id === result.taskIds[0]);
    // 调度器会立刻取走任务，因此是 running；并发已满时才是 queued
    expect(['running', 'queued']).toContain(task?.status);
    expect(task?.title).toBe('影片E');
  });
});
