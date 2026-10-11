import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Custom extractor for PowerBuilder DataWindow objects (`.srd`).
 *
 * A DataWindow export is a text format, not PowerScript: a header, then a long
 * layout of bands, texts and columns (fonts, sizes, colours) that says nothing
 * about the program. What matters is one block near the top,
 *
 *     table(column=(type=char(20) updatewhereclause=yes name=sec dbname="t.sec" )
 *      column=(...)
 *      retrieve="select ... " update="T" updatewhere=1 arguments=(("id", number)) )
 *
 * plus two things further down: a nested `report(... dataobject="d_x" ...)` and
 * a column's `dddw.name=d_x` drop-down, which each name another DataWindow.
 * Only these are read; the layout is skipped.
 *
 * Extracted information:
 * - The DataWindow as NodeKind `component` (decorated `datawindow`): a data and
 *   UI component, which `codegraph_explore` also lets a query name exactly (a
 *   `class` is never a named seed), and which the resolver finds by name so a
 *   PowerScript `dataobject = "d_x"` links to it
 * - Its columns as NodeKind `field`, with their type and database column
 * - The retrieve SQL as the node's docstring, the tables it reads, the table it
 *   updates and its retrieval arguments in the signature
 * - Nested reports and drop-down DataWindows as `references` to other
 *   DataWindows
 *
 * The node spans the `table(...)` block only, so showing its source shows the
 * columns and the SQL, not the layout that can run to megabytes.
 */

const LANGUAGE = 'powerbuilder' as const;

/** A guard, not a design limit: the SQL of the largest DataWindows is a few KB. */
const MAX_SQL_CHARS = 200_000;
const MAX_TABLES = 50;

const TILDE = 126; // `~`, PowerBuilder's escape character inside a quoted string
const QUOTE = 34; // `"`
const OPEN = 40; // `(`
const CLOSE = 41; // `)`

/** The index just past the quote that ends the string opening at `open`. `~` escapes the next character (`~"`, `~~`). */
function skipString(src: string, open: number): number {
  let i = open + 1;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === TILDE) i += 2;
    else if (c === QUOTE) return i + 1;
    else i++;
  }
  return src.length;
}

/** The index just past the parenthesis closing the one at `open`, skipping strings; -1 if it never closes. */
function skipParens(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === QUOTE) {
      i = skipString(src, i);
      continue;
    }
    if (c === OPEN) depth++;
    else if (c === CLOSE && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

interface Attribute {
  key: string;
  /** The value as written, quotes and parentheses included. */
  value: string;
  /** Where the attribute starts in the text it was read from. */
  at: number;
}

/** The `key=value` pairs of a parenthesized block, at its own level only. */
function topLevelAttributes(block: string, from: number): Attribute[] {
  const found: Attribute[] = [];
  const keyAt = /[A-Za-z_][\w.]*/y;
  let i = from;
  while (i < block.length) {
    const c = block.charCodeAt(i);
    if (c === CLOSE) break;
    if (c <= 32) {
      i++;
      continue;
    }
    keyAt.lastIndex = i;
    const key = keyAt.exec(block);
    if (!key || block[keyAt.lastIndex] !== '=') {
      i++;
      continue;
    }
    const start = i;
    let valueStart = keyAt.lastIndex + 1;
    const first = block.charCodeAt(valueStart);
    let end: number;
    if (first === QUOTE) end = skipString(block, valueStart);
    else if (first === OPEN) {
      end = skipParens(block, valueStart);
      if (end < 0) end = block.length;
    } else {
      end = valueStart;
      while (end < block.length && block.charCodeAt(end) > 32 && block.charCodeAt(end) !== CLOSE) end++;
    }
    found.push({ key: key[0], value: block.slice(valueStart, end), at: start });
    i = end;
  }
  return found;
}

/** `"select ~"a~" from t"` → `select "a" from t`. */
function unquote(value: string): string {
  const inner = value.startsWith('"') ? value.slice(1, value.endsWith('"') && value.length > 1 ? -1 : undefined) : value;
  return inner.replace(/~(["~])/g, '$1');
}

/** The database tables a retrieve statement reads, in order of appearance. */
export function tablesInSql(sql: string): string[] {
  const tables: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const name = raw.replace(/"/g, '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || tables.length >= MAX_TABLES) return;
    seen.add(key);
    tables.push(name);
  };

  // A painted (PBSELECT) statement names its tables in TABLE(NAME="...").
  for (const m of sql.matchAll(/\bTABLE\s*\(\s*NAME\s*=\s*"([^"]+)"/gi)) add(m[1]!);

  const text = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  const ref = /\s*("[^"]+"|[A-Za-z_][\w$#]*(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$#]*))*)(?:\s+(?:as\s+)?(?!(?:where|group|order|having|union|inner|left|right|full|cross|join|on|set|connect|start|minus|intersect)\b)[A-Za-z_][\w$#]*)?/iy;
  for (const m of text.matchAll(/\b(from|join)\b/gi)) {
    let at = m.index! + m[0].length;
    for (;;) {
      ref.lastIndex = at;
      const t = ref.exec(text);
      if (!t) break;
      add(t[1]!.replace(/\s*\.\s*/g, '.')); // `a . b` is `a.b`; a space inside a quoted name stays
      at = ref.lastIndex;
      // `from a x, b y` — only a FROM list continues with a comma.
      const comma = /\s*,/y;
      comma.lastIndex = at;
      if (m[1]!.toLowerCase() !== 'from' || !comma.exec(text)) break;
      at = comma.lastIndex;
    }
  }
  return tables;
}

export class DataWindowExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [0];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) this.lineStarts.push(i + 1);
  }

  /** Extract the DataWindow, its columns, its SQL and the DataWindows it names. */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.parseDataWindow(fileNode);
    } catch (error) {
      this.errors.push({
        message: `DataWindow extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /** 1-based line of a character index. */
  private lineOf(index: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  private columnOf(index: number): number {
    return index - this.lineStarts[this.lineOf(index) - 1]!;
  }

  private createFileNode(): Node {
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: LANGUAGE,
      startLine: 1,
      endLine: this.lineStarts.length,
      startColumn: 0,
      endColumn: this.source.length - this.lineStarts[this.lineStarts.length - 1]!,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  private parseDataWindow(fileNode: Node): void {
    const { source } = this;
    const header = /\$PBExportHeader\$([^\s.]+)\.srd/i.exec(source.slice(0, 300));
    const name = header?.[1] ?? (this.filePath.split('/').pop() ?? this.filePath).replace(/\.srd$/i, '');
    const release = /^release\s+(\d+)/m.exec(source.slice(0, 2000))?.[1];

    const tableStart = source.search(/^table\(/m);
    let tableEnd = -1;
    let attributes: Attribute[] = [];
    if (tableStart >= 0) {
      const open = tableStart + 'table'.length;
      tableEnd = skipParens(source, open);
      const block = source.slice(tableStart, tableEnd < 0 ? undefined : tableEnd);
      attributes = topLevelAttributes(block, 'table('.length).map((a) => ({ ...a, at: a.at + tableStart }));
    }

    const sql = attributes.find((a) => a.key === 'retrieve');
    const sqlText = sql ? unquote(sql.value).replace(/\r\n/g, '\n').slice(0, MAX_SQL_CHARS) : undefined;
    const reads = sqlText ? tablesInSql(sqlText) : [];
    const updates = attributes.find((a) => a.key === 'update');
    const updateTable = updates ? unquote(updates.value) : '';
    const args = attributes.find((a) => a.key === 'arguments');
    const argumentList = args
      ? [...args.value.matchAll(/\(\s*"([^"]+)"\s*,\s*([A-Za-z]+)/g)].map((m) => `${m[1]}: ${m[2]}`)
      : [];

    const parts = [`datawindow${release ? ` (release ${release})` : ''}`];
    if (reads.length > 0) parts.push(`reads ${reads.join(', ')}`);
    if (updateTable) parts.push(`updates ${updateTable}`);
    if (argumentList.length > 0) parts.push(`arguments ${argumentList.join(', ')}`);

    const startLine = tableStart >= 0 ? this.lineOf(tableStart) : 2;
    const endLine = tableStart >= 0 ? this.lineOf(Math.max(tableStart, (tableEnd < 0 ? source.length : tableEnd) - 1)) : 2;
    const dw: Node = {
      id: generateNodeId(this.filePath, 'component', name, startLine),
      kind: 'component',
      name,
      qualifiedName: name,
      filePath: this.filePath,
      language: LANGUAGE,
      startLine,
      endLine,
      startColumn: 0,
      endColumn: 0,
      signature: parts.join(' · '),
      docstring: sqlText,
      decorators: ['datawindow'],
      visibility: 'public',
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(dw);
    this.edges.push({ source: fileNode.id, target: dw.id, kind: 'contains' });

    const columns = new Map<string, Node>();
    for (const attr of attributes) {
      if (attr.key !== 'column') continue;
      const tuple = attr.value.slice(1, attr.value.endsWith(')') ? -1 : undefined);
      const columnName = /(?:^|\s)name=([A-Za-z_][\w$#.-]*)/.exec(tuple)?.[1];
      if (!columnName) continue;
      const type = /(?:^|\s)type=(\S+)/.exec(tuple)?.[1] ?? '';
      const dbname = /\bdbname="([^"]*)"/.exec(tuple)?.[1];
      const line = this.lineOf(attr.at);
      const column: Node = {
        id: generateNodeId(this.filePath, 'field', `${name}::${columnName}`, line),
        kind: 'field',
        name: columnName,
        qualifiedName: `${name}::${columnName}`,
        filePath: this.filePath,
        language: LANGUAGE,
        startLine: line,
        endLine: this.lineOf(attr.at + attr.key.length + attr.value.length),
        startColumn: this.columnOf(attr.at),
        endColumn: 0,
        signature: dbname && dbname !== columnName ? `${type} ← ${dbname}` : type,
        decorators: /\bkey=yes\b/.test(tuple) ? ['key'] : undefined,
        visibility: 'public',
        updatedAt: Date.now(),
      };
      this.nodes.push(column);
      this.edges.push({ source: dw.id, target: column.id, kind: 'contains' });
      columns.set(columnName.toLowerCase(), column);
    }

    this.addNestedReports(dw);
    this.addDropDowns(dw, columns);
  }

  private addReference(from: Node, name: string, at: number, seen: Set<string>): void {
    const key = `${from.id}\0${name.toLowerCase()}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    this.unresolvedReferences.push({
      fromNodeId: from.id,
      referenceName: name,
      referenceKind: 'references',
      line: this.lineOf(at),
      column: this.columnOf(at),
      filePath: this.filePath,
      language: LANGUAGE,
    });
  }

  /** `report(band=detail dataobject="d_x" ...)` — a report nested in this one. */
  private addNestedReports(dw: Node): void {
    const seen = new Set<string>();
    const re = /^report\([^\n]*?\bdataobject="([^"\n]+)"/gm;
    for (let m = re.exec(this.source); m; m = re.exec(this.source)) {
      this.addReference(dw, m[1]!, m.index, seen);
    }
  }

  /** `column(... name=c dddw.name=d_x ...)` — the DataWindow behind a column's drop-down. */
  private addDropDowns(dw: Node, columns: Map<string, Node>): void {
    const { source } = this;
    const seen = new Set<string>();
    const needle = 'dddw.name=';
    for (let i = source.indexOf(needle); i >= 0; i = source.indexOf(needle, i + needle.length)) {
      const value = /^[A-Za-z_][\w$#.-]*/.exec(source.slice(i + needle.length, i + needle.length + 200))?.[0];
      if (!value) continue;
      const lineStart = source.lastIndexOf('\n', i) + 1;
      if (!source.startsWith('column(', lineStart)) continue;
      const owner = /(?:^|\s)name=([A-Za-z_][\w$#.-]*)/.exec(source.slice(lineStart, i))?.[1];
      this.addReference((owner && columns.get(owner.toLowerCase())) || dw, value, i, seen);
    }
  }
}
