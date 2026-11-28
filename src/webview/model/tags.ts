import { authorColumnWidth, truncateAuthor } from '../../git/log';
import { TagEntry } from '../../git/tags';
import { t } from '../../i18n';
import type { FactModel, ListModel, RowItemModel, RowPartModel } from '../protocol';
import { parseHints } from './hints';

/** An annotation is a note beside the tag, not a paragraph: the buffer cuts it here. */
const ANNOTATION_WIDTH = 40;
/** Columns of the commit part, the same constants `tagsRender` uses. */
const SHA_WIDTH = 9;
const DATE_WIDTH = 18;
const GAP = 2;

/**
 * The tags screen as the panel draws it. One block, one row per tag: the name in the
 * branch colour, the annotation beside it, then the commit the tag points at — hash,
 * date, author, subject — painted piece by piece like the buffer's columns.
 *
 * The rows are a table, not a list: every column is padded to the widest value of the
 * screen, the same `padEnd()` arithmetic `renderTags()` does, so the sha, the date and
 * the author sit under each other exactly as they do in the text buffer.
 */
export function buildTagsModel(repoPath: string, tags: TagEntry[], remote?: string): ListModel {
  // The count the buffer printed under the title is gone: the rows are the count.
  const unpushed = tags.filter((tag) => tag.pushed === false).length;
  const facts: FactModel[] =
    remote && unpushed > 0
      ? [{ label: '', value: t('tags.unpushed', { count: unpushed, remote }), role: 'meta' }]
      : [];

  const annotations = tags.map((tag) => (tag.annotation ? truncate(tag.annotation, ANNOTATION_WIDTH) : ''));
  const nameWidth = tags.reduce((width, tag) => Math.max(width, tag.name.length), 0) + GAP;
  const annotationWidth = annotations.some((text) => text.length > 0)
    ? annotations.reduce((width, text) => Math.max(width, text.length), 0) + GAP
    : 0;
  const authorWidth = authorColumnWidth(tags.map((tag) => tag.author));

  const rows: RowItemModel[] = tags.map((tag, index) => {
    const author = truncateAuthor(tag.author);
    const date = truncate(tag.date, DATE_WIDTH);
    const parts: RowPartModel[] = [
      // The padding of the name column and the annotation column in one piece: the name
      // itself stays the row's text, so copying a row gives the tag name and nothing else.
      {
        text: ' '.repeat(Math.max(0, nameWidth - tag.name.length)) + annotations[index].padEnd(annotationWidth),
        role: 'meta',
      },
      { text: tag.sha.padEnd(SHA_WIDTH), role: 'hash' },
      { text: date.padEnd(DATE_WIDTH), role: 'date' },
      { text: author.padEnd(authorWidth), role: 'author' },
      // The buffer leaves the subject in the editor foreground, so the panel does too.
      { text: tag.subject, role: 'plain' },
    ];
    return {
      id: `tag:${tag.name}`,
      text: tag.name,
      // A tag missing on the remote is the one row that needs attention: it takes the
      // coral "untracked" colour instead of the green of a pushed tag.
      role: tag.pushed === false ? 'untracked' : 'branch',
      parts,
      aligned: true,
    };
  });

  return {
    kind: 'tags',
    title: t('tags.title', { repo: repoPath }),
    facts,
    hints: parseHints(t('tags.keys')),
    blocks: [{ title: t('tags.section'), role: 'section', hints: [], rows, empty: t('webview.emptyList') }],
    selectFirst: t('webview.selectItem'),
    emptyText: t('webview.emptyList'),
  };
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}
