import { describe, it, expect } from 'vitest';
import type { ZodObject } from 'zod';
import * as S from '../src/llm/schema.js';

/**
 * Every tool's input is declared TWICE: a Zod schema (validates the model's
 * arguments at runtime) and a hand-written JSON Schema (what the model actually
 * sees). These must not drift — a field added to one but not the other fails
 * silently at the model boundary. This guards property names + required-ness for
 * each tool so a mismatch is caught at test time instead of in production.
 */
interface JsonSchema {
  properties: Record<string, unknown>;
  required?: readonly string[];
}

const PAIRS: { name: string; zod: ZodObject<Record<string, never>>; json: JsonSchema }[] = [
  { name: 'record_expense', zod: S.RecordExpenseZ as never, json: S.recordExpenseJsonSchema },
  { name: 'remember', zod: S.RememberZ as never, json: S.rememberJsonSchema },
  { name: 'edit_memory', zod: S.EditMemoryZ as never, json: S.editMemoryJsonSchema },
  { name: 'learn_expense_pattern', zod: S.LearnExpenseZ as never, json: S.learnExpenseJsonSchema },
  { name: 'edit_lexicon', zod: S.EditLexiconZ as never, json: S.editLexiconJsonSchema },
  { name: 'add_poi', zod: S.AddPoiZ as never, json: S.addPoiJsonSchema },
  { name: 'schedule_task', zod: S.ScheduleTaskZ as never, json: S.scheduleTaskJsonSchema },
  { name: 'surf_forecast', zod: S.SurfForecastZ as never, json: S.surfForecastJsonSchema },
  { name: 'spending_report', zod: S.SpendingReportZ as never, json: S.spendingReportJsonSchema },
];

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

describe('Zod ↔ JSON schema parity (per tool)', () => {
  for (const { name, zod, json } of PAIRS) {
    it(`${name}: same top-level property names`, () => {
      const zodKeys = sorted(Object.keys(zod.shape));
      const jsonKeys = sorted(Object.keys(json.properties));
      expect(jsonKeys, `${name} property names differ`).toEqual(zodKeys);
    });

    it(`${name}: same required fields`, () => {
      const shape = zod.shape as Record<string, { isOptional(): boolean }>;
      const zodRequired = sorted(Object.keys(shape).filter((k) => !shape[k]!.isOptional()));
      const jsonRequired = sorted(json.required ?? []);
      expect(jsonRequired, `${name} required fields differ`).toEqual(zodRequired);
    });
  }
});
