import { en, MessageKey } from './en';
import { ru } from './ru';
import { zh } from './zh';

export type { MessageKey };

export type Language = 'en' | 'ru' | 'zh';

export interface LanguageChoice {
  id: Language;
  label: string;
}

export const LANGUAGES: LanguageChoice[] = [
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
  { id: 'zh', label: '中文' },
];

const TABLES: Record<Language, Record<MessageKey, string>> = { en, ru, zh };

let current: Language = 'en';

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && value in TABLES;
}

export function setLanguage(language: Language): void {
  current = isLanguage(language) ? language : 'en';
}

export function getLanguage(): Language {
  return current;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const table = TABLES[current] ?? en;
  const template = table[key] ?? en[key] ?? key;
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    params[name] === undefined ? '' : String(params[name])
  );
}
