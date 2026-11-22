import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { zh } from '../src/i18n/zh';
import { getLanguage, LANGUAGES, setLanguage, t } from '../src/i18n';

afterEach(() => {
  setLanguage('en');
});

describe('translations', () => {
  it('ships the same key set in every language', () => {
    const keys = Object.keys(en).sort();
    assert.deepEqual(Object.keys(ru).sort(), keys);
    assert.deepEqual(Object.keys(zh).sort(), keys);
  });

  it('has no empty translations', () => {
    for (const table of [en, ru, zh]) {
      for (const [key, value] of Object.entries(table)) {
        assert.ok(value.trim().length > 0, `empty translation for ${key}`);
      }
    }
  });

  it('tells the reader of a commit’s file list about the new key', () => {
    // The hint line is the only place the key is advertised: the palette is closed, and a
    // reader on that screen is looking at the file list, not at the docs.
    for (const table of [en, ru, zh]) {
      assert.match(table['hints.commitFiles'], /(^|\s)t /);
    }
  });

  it('offers three languages and defaults to English', () => {
    assert.equal(getLanguage(), 'en');
    assert.deepEqual(
      LANGUAGES.map((language) => language.id),
      ['en', 'ru', 'zh']
    );
    assert.equal(t('status.section.staged'), 'staged');
  });

  it('switches the active table', () => {
    setLanguage('ru');
    assert.equal(t('status.section.staged'), 'в индексе');
    setLanguage('zh');
    assert.equal(t('status.section.staged'), '已暂存');
    setLanguage('en');
    assert.equal(t('status.section.staged'), 'staged');
  });

  it('interpolates parameters', () => {
    assert.equal(t('status.diverged', { ref: 'origin/main', ahead: 2, behind: 5 }), 'origin/main: +2 −5');
    setLanguage('ru');
    assert.ok(t('msg.stagedCount', { count: 3 }).includes('3'));
  });

  it('falls back to English for an unknown language', () => {
    setLanguage('xx' as never);
    assert.equal(getLanguage(), 'en');
  });
});
