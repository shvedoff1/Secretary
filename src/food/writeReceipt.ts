import type { FoodToolResult } from './handler.js';

export type FoodWriteReceipt = NonNullable<FoodToolResult['write']>;

/** A missed action may be retried; a question about a past action must not write again. */
export function requestsDiaryWrite(text: string, hasImage = false): boolean {
  if (/(?:почему|зачем|что\s+(?:произошло|случилось)|как\s+(?:это\s+)?работает)/iu.test(text)) return false;
  return /(?:запиш|записать|добав|исправ|поправ|передел|пересчит|пересч[её]т|перепров|съел|съела|поел|поела|выпил|выпила|удал|убери|убрать|обнов|замени)/iu.test(text)
    || (hasImage && !text.trim());
}

/** A bounded backstop for common fabricated confirmations, including bare «готово». */
export function claimsCompletedWrite(text: string): boolean {
  return text.split(/[.!?\n;]/).some((sentence) => {
    const s = sentence.toLowerCase().trim();
    if (/[?]/.test(text) && !/[.!\n;]/.test(text)) return false;
    if (/(?:не|не\s+смог|не\s+удалось|ещё\s+не|еще\s+не)\s+(?:\S+\s+){0,2}(?:записа|сохрани|исправ|поправ|обнов|добав|удал|убра|вн[её]с)/u.test(s)) return false;
    if (/(?:если|когда|чтобы|могу|нужно|надо|попробуй|напиши|скажи|например)/u.test(s)) return false;
    return /(?:^|[\s,:—-])(?:я\s+)?(?:записал[аи]?|сохранил[аи]?|исправил[аи]?|поправил[аи]?|переделал[аи]?|поменял[аи]?|заменил[аи]?|обновил[аи]?|добавил[аи]?|удалил[аи]?|убрал[аи]?|вн[её]с(?:ла)?|готово|записано|сохранено|исправлено|обновлено|добавлено|внесено)(?=$|[\s,:—-])/u.test(s)
      || /(?:дневник|запись|еда)\s+(?:обновл[её]н[ао]?|исправлен[ао]?|сохран[её]н[ао]?|записан[ао]?|добавлен[ао]?)/u.test(s)
      || /^(?:done|saved|logged|updated|fixed|recorded)(?:\b)/i.test(s);
  });
}

/** Never let the model reinterpret failed/no-op writes as success. */
export function foodReceiptText(receipts: FoodWriteReceipt[]): string {
  const messages = [...new Set(receipts.map((r) => r.message))];
  const partial = receipts.some((r) => r.status === 'saved') && receipts.some((r) => r.status === 'failed');
  return `${partial ? 'Изменения выполнены частично. ' : ''}${messages.join(' ')}`;
}
