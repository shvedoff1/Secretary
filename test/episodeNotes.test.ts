import { describe, it, expect } from 'vitest';
import { parseEpisodeJson } from '../src/llm/episode.js';
import { buildTopicIndex } from '../src/util/topicIndex.js';

// The episode notes parser is the write path of episodic memory: anything it
// accepts becomes what the bot "remembers happening", so it must be defensive —
// bad output yields null (retry later), never garbage stored as memory.

describe('parseEpisodeJson', () => {
  it('parses a clean object', () => {
    expect(
      parseEpisodeJson('{"summary":"строка 1\\nстрока 2","topics":["Поездка "," серф"]}'),
    ).toEqual({ summary: 'строка 1\nстрока 2', topics: ['поездка', 'серф'] });
  });

  it('digs the object out of prose and fences', () => {
    const wrapped = 'Вот заметки:\n```json\n{"summary":"обсуждали катку","topics":["дота"]}\n```';
    expect(parseEpisodeJson(wrapped)).toEqual({ summary: 'обсуждали катку', topics: ['дота'] });
  });

  it('rejects a missing or blank summary', () => {
    expect(parseEpisodeJson('{"topics":["x"]}')).toBeNull();
    expect(parseEpisodeJson('{"summary":"   ","topics":["x"]}')).toBeNull();
    expect(parseEpisodeJson('нет тут json')).toBeNull();
    expect(parseEpisodeJson('{"summary": broken')).toBeNull();
  });

  it('tolerates bad topics: drops non-strings, caps at 6', () => {
    const parsed = parseEpisodeJson(
      '{"summary":"ok","topics":[1, "a", null, "b", "c", "d", "e", "f", "g"]}',
    );
    expect(parsed?.topics).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(parseEpisodeJson('{"summary":"ok"}')?.topics).toEqual([]);
  });
});

// The topic index is the "what could I recall?" line in the depth hint: people
// first (the flagship «что ты знаешь про X» case), then recurring themes.

describe('buildTopicIndex', () => {
  it('puts people before themes and dedups case-insensitively', () => {
    const out = buildTopicIndex({
      subjects: ['Гоша', 'гоша', 'Андрей'],
      episodeTopics: [['серф'], ['серф', 'поездка'], ['Гоша']],
      max: 10,
    });
    expect(out).toEqual(['Гоша', 'Андрей', 'серф', 'поездка']);
  });

  it('ranks themes by frequency, then by recency', () => {
    const out = buildTopicIndex({
      subjects: [],
      episodeTopics: [['старое', 'дота'], ['дота'], ['новое']],
      max: 10,
    });
    // «дота» twice beats both; «новое» (last episode) beats «старое» (first).
    expect(out).toEqual(['дота', 'новое', 'старое']);
  });

  it('respects the cap', () => {
    const out = buildTopicIndex({
      subjects: ['a', 'b'],
      episodeTopics: [['c', 'd', 'e']],
      max: 3,
    });
    expect(out).toEqual(['a', 'b', 'c']);
  });
});
