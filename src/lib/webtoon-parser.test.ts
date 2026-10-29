import { describe, expect, it } from 'vitest';
import { decodeWebtoonId, parseWebtoonCatalog, parseWebtoonChapters, parseWebtoonImages } from './webtoon-parser';

describe('public webtoon sources', () => {
  it('uses distinct source and chapter namespaces', () => {
    expect(decodeWebtoonId('wt4149.1')).toEqual({ source: 'webtoon-zh', title: '4149', episode: '1' });
    expect(decodeWebtoonId('wd1313')?.source).toBe('dongman');
    expect(decodeWebtoonId('we123')?.source).toBe('webtoon-en');
    expect(decodeWebtoonId('wt../etc')).toBeNull();
  });
  it('deduplicates catalog entries and omits age-gated entries and other hosts', () => {
    const card = '<a href="https://www.webtoons.com/zh-hant/fantasy/book/list?title_no=12"><img src="https://webtoon-phinf.pstatic.net/cover.jpg"><strong class="title">甲 &amp; 乙</strong><div class="genre">奇幻</div></a>';
    const mature = card.replace('奇幻', '大人系').replace('12', '13');
    expect(parseWebtoonCatalog(card + card + mature + card.replace('www.webtoons.com', 'evil.test'), 'webtoon-zh').map(i => i.title)).toEqual(['甲 & 乙']);
  });
  it('keeps episode ids distinct from display numbers and decodes entities', () => {
    const html = '<a href="/a/b/viewer?title_no=12&amp;episode_no=9"><span class="subj"><span>第8話</span></span></a>';
    expect(parseWebtoonChapters(html, 'wt12')[0]).toMatchObject({ id: 'wt12.9', number: '8', title: '第8話' });
  });
  it('returns only actual reader images on the source CDN', () => {
    const html = '<img class="_thumbnailImages" data-url="https://webtoon-phinf.pstatic.net/thumb.jpg"><img class="_images" data-url="https://webtoon-phinf.pstatic.net/page.jpg?a=1&amp;b=2"><img class="_images" data-url="https://evil.test/page.jpg"><img class="_images" data-url="http://127.0.0.1/page.jpg">';
    expect(parseWebtoonImages(html, 'webtoon-zh')).toEqual(['https://webtoon-phinf.pstatic.net/page.jpg?a=1&b=2']);
  });
});
