export interface MangaProgress { mangaId: string; chapterId: string; page: number; updatedAt: number }
const KEY = 'libretv-manga-progress-v1';
export function parseMangaProgress(raw: string | null): MangaProgress[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((p): p is MangaProgress => p && typeof p.mangaId === 'string' && typeof p.chapterId === 'string' && Number.isInteger(p.page) && p.page >= 0 && Number.isFinite(p.updatedAt)).slice(0, 100);
  } catch { return []; }
}
export function readMangaProgress(id: string): MangaProgress | undefined {
  try { return parseMangaProgress(localStorage.getItem(KEY)).find(p => p.mangaId === id); } catch { return undefined; }
}
export function saveMangaProgress(progress: MangaProgress): void {
  try {
    const rows = parseMangaProgress(localStorage.getItem(KEY)).filter(p => p.mangaId !== progress.mangaId);
    localStorage.setItem(KEY, JSON.stringify([progress, ...rows].slice(0, 100)));
  } catch { /* Storage may be unavailable or full; reading must remain usable. */ }
}
export function removeMangaProgress(id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(parseMangaProgress(localStorage.getItem(KEY)).filter(p => p.mangaId !== id))); } catch { /* optional storage */ }
}
