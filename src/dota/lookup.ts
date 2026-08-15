import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  countDotaEntities,
  findDotaEntity,
  getDotaSyncState,
  searchDotaEntities,
  type DotaEntity,
} from '../db/repos/dota.repo.js';
import type { DotaLookupInput } from '../llm/schema.js';

// The `dota_lookup` tool handler: names/queries in, ready text cards out. Reads
// only local SQLite (the nightly sync in ./sync.ts fills it), so a lookup adds
// no network latency to the turn — the whole point of pre-rendering cards.

/** Entities are returned in full until this many characters are spent, then as digests. */
const FULL_CARD_BUDGET = 6000;

function describeMiss(name: string, kind: DotaLookupInput['kind']): string {
  const wanted = kind === 'any' ? null : kind;
  const near = searchDotaEntities(name, 4, wanted);
  if (near.length === 0) {
    return `«${name}» — не нашёл в базе. Проверь английское название (база хранит их так, как их пишет Valve).`;
  }
  return `«${name}» — точного совпадения нет. Похожее в базе: ${near
    .map((e) => e.name)
    .join(', ')}. Если имелось в виду одно из них — переспроси или уточни название.`;
}

/**
 * Build the tool handler. Stateless — the same instance serves the live chat
 * flow and the scheduler (so a recurring "разбор патча по утрам" task works).
 */
export function makeDotaLookupHandler(): (input: DotaLookupInput) => string {
  return (input) => {
    const cfg = loadConfig();
    if (!cfg.ENABLE_DOTA) {
      return 'База по доте выключена. Ответь из собственных знаний и предупреди, что данные могут быть неактуальны.';
    }

    const counts = countDotaEntities();
    if (counts.hero === 0 && counts.item === 0) {
      return 'База по доте ещё не загружена (синк не проходил). Ответь из собственных знаний и честно предупреди, что данные могут быть устаревшими.';
    }

    const state = getDotaSyncState();
    const kind = input.kind === 'any' ? null : input.kind;
    const names = (input.names ?? []).map((n) => n.trim()).filter((n) => n.length > 0);
    const blocks: string[] = [];
    let budget = FULL_CARD_BUDGET;

    const push = (entity: DotaEntity): void => {
      // Spend the budget on the first entities in full, then degrade to digests
      // instead of truncating mid-card — a half-card reads as complete and the
      // model would quote whatever numbers survived the cut.
      if (budget >= entity.card.length) {
        blocks.push(entity.card);
        budget -= entity.card.length;
      } else {
        blocks.push(entity.summary);
        budget -= entity.summary.length;
      }
    };

    const seen = new Set<number>();
    for (const name of names.slice(0, cfg.DOTA_MAX_CARDS)) {
      const entity = findDotaEntity(name, kind);
      if (!entity) {
        blocks.push(describeMiss(name, input.kind));
        continue;
      }
      if (seen.has(entity.id)) continue;
      seen.add(entity.id);
      push(entity);

      // "Что поменяли у Акса" is a patch question; but so is asking about a hero
      // right after a patch. Attach the entity's patch notes when they exist so
      // the model never has to make a second call for them.
      const patchNotes = findDotaEntity(name, 'patch');
      if (patchNotes && !seen.has(patchNotes.id)) {
        seen.add(patchNotes.id);
        blocks.push(patchNotes.card);
      }
    }

    const query = (input.query ?? '').trim();
    if (query) {
      const found = searchDotaEntities(query, cfg.DOTA_MAX_CARDS, kind).filter(
        (e) => !seen.has(e.id),
      );
      if (found.length === 0) {
        blocks.push(`По запросу «${query}» в базе ничего не нашлось.`);
      } else {
        for (const entity of found) {
          seen.add(entity.id);
          push(entity);
        }
      }
    }

    if (blocks.length === 0) {
      return 'Пустой запрос — назови героя/предмет по-английски или задай поисковый запрос.';
    }

    logger.debug(
      { names, query, kind: input.kind, blocks: blocks.length },
      'dota_lookup served',
    );

    const patch = state.patch ?? 'неизвестен';
    return [
      `Данные из локальной базы, патч ${patch}. Это АКТУАЛЬНЫЕ цифры — используй именно их, а не свою память.`,
      ...blocks,
    ].join('\n\n');
  };
}
