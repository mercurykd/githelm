import { t } from '../i18n';
import type { LogFilter } from '../git/log';

/** The fields of the log filter, in the order the dialog and the panel list them. */
export type FilterField = keyof LogFilter;

export const FILTER_FIELDS: FilterField[] = ['grep', 'author', 'pickaxe', 'pickaxeRegex', 'since', 'until', 'path'];

/** The name of a filter field, and the hint under it, in the reader's language. */
export function fieldLabel(field: FilterField): string {
  return t(`log.field.${field}` as `log.field.${FilterField}`);
}

export function filterHint(field: FilterField): string {
  return t(`log.fieldHint.${field}` as `log.fieldHint.${FilterField}`);
}
