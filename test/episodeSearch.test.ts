import { describe, it, expect } from 'vitest';
import { searchEpisodes } from '../src/episodes/search.js';
import { episodeWhen, renderEpisodeLine } from '../src/episodes/render.js';
import type { ChatEpisode } from '../src/db/repos/episode.repo.js';

const at = (iso: string): number => Date.parse(iso);

function ep(partial: Partial<ChatEpisode> & { id: number }): ChatEpisode {
  return {
    chatId: 1,
    startedAt: at('2026-08-21T18:00:00Z'),
    endedAt: at('2026-08-21T20:00:00Z'),
    messageCount: 10,
    summary: '',
    topics: [],
    createdAt: 0,
    ...partial,
  };
}

describe('searchEpisodes', () => {
  it('matches over notes AND topic tags, ranking the better match first', () => {
    const episodes = [
      ep({ id: 1, summary: 'обсуждали работу', topics: ['работа'] }),
      ep({ id: 2, summary: 'Гоша ищет доску для сёрфа', topics: ['серф', 'поездка'] }),
      ep({ id: 3, summary: 'болтали ни о чём', topics: ['флуд'] }),
    ];
    const hits = searchEpisodes(episodes, 'серф доска', { limit: 5 });
    expect(hits.map((h) => h.episode.id)).toEqual([2]);
  });

  it('breaks ties by recency (the newer session first)', () => {
    const episodes = [
      ep({ id: 1, endedAt: at('2026-08-01T20:00:00Z'), summary: 'обсуждали рыбалку', topics: [] }),
      ep({ id: 2, endedAt: at('2026-08-21T20:00:00Z'), summary: 'обсуждали рыбалку', topics: [] }),
    ];
    const hits = searchEpisodes(episodes, 'рыбалка', { limit: 5 });
    expect(hits.map((h) => h.episode.id)).toEqual([2, 1]);
  });

  it('caps results and returns nothing for an empty query', () => {
    const episodes = [1, 2, 3, 4].map((id) => ep({ id, summary: 'про рыбалку', topics: [] }));
    expect(searchEpisodes(episodes, 'рыбалку', { limit: 2 })).toHaveLength(2);
    expect(searchEpisodes(episodes, '', { limit: 2 })).toEqual([]);
  });
});

describe('episode rendering', () => {
  it('labels a single-day session with its human and ISO date', () => {
    const label = episodeWhen(
      { startedAt: at('2026-08-21T18:00:00Z'), endedAt: at('2026-08-21T20:00:00Z') },
      'UTC',
    );
    expect(label).toContain('(2026-08-21)');
    expect(label).toContain('августа');
  });

  it('labels a session that crossed midnight as a range', () => {
    const label = episodeWhen(
      { startedAt: at('2026-08-21T22:00:00Z'), endedAt: at('2026-08-22T01:00:00Z') },
      'UTC',
    );
    expect(label).toContain('2026-08-21');
    expect(label).toContain('2026-08-22');
  });

  it('flattens multi-line notes into one journal line with topics', () => {
    const line = renderEpisodeLine(
      ep({ id: 1, summary: 'решили ехать\nГоша против', topics: ['поездка'] }),
      'UTC',
    );
    expect(line).toContain('[темы: поездка]');
    expect(line).toContain('решили ехать • Гоша против');
    expect(line).not.toContain('\n');
  });
});
