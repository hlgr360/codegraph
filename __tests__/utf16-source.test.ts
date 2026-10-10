/**
 * A source file saved as UTF-16 (byte-order mark first) is read as the text it
 * holds — Windows tools write UTF-16, PowerBuilder's exports among them. Read
 * as UTF-8 it was NULs between letters: the file indexed with no symbols, and
 * explore had nothing readable to show. A UTF-8 file decodes exactly as before,
 * so no stored content hash changes.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { decodeSourceText } from '../src/file-limits';
import { ToolHandler } from '../src/mcp/tools';
import { validateAnswerFiles } from '../src/mcp/answer-freshness';

const utf16le = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = (text: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

describe('decodeSourceText', () => {
  it('reads UTF-16 by its byte-order mark, keeping the mark as UTF-8 files do', () => {
    expect(decodeSourceText(utf16le('global type x\r\n'))).toBe('\uFEFFglobal type x\r\n');
    expect(decodeSourceText(utf16be('global type x\r\n'))).toBe('\uFEFFglobal type x\r\n');
    expect(decodeSourceText(utf16le('名前 é'))).toBe('\uFEFF名前 é');
  });

  it('decodes UTF-8 exactly as before', () => {
    for (const bytes of [Buffer.from('plain ascii'), Buffer.from('\uFEFFwith bom 名前'), Buffer.alloc(0), Buffer.from([0xff])]) {
      expect(decodeSourceText(bytes)).toBe(bytes.toString('utf8'));
    }
  });
});

describe('a UTF-16 PowerBuilder export', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-utf16-'));
    fs.mkdirSync(path.join(root, 'app.pbl'));
    fs.writeFileSync(path.join(root, 'app.pbl', 'n_base.sru'), utf16le(`$PBExportHeader$n_base.sru\r
global type n_base from nonvisualobject\r
end type\r
global n_base n_base\r
\r
public function integer of_load ();return 1\r
end function\r
`));
    fs.writeFileSync(path.join(root, 'app.pbl', 'n_orders.sru'), utf16le(`$PBExportHeader$n_orders.sru\r
global type n_orders from n_base\r
end type\r
global n_orders n_orders\r
\r
public function integer of_run ();// Lädt die Aufträge\r
return OF_LOAD()\r
end function\r
`));
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('indexes its symbols and resolves across files', () => {
    const run = cg.getNodesInFile('app.pbl/n_orders.sru').find((n) => n.name === 'of_run');
    expect(run?.kind).toBe('method');
    const callees = cg.getOutgoingEdgesFrom([run!.id], ['calls']).map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(callees).toEqual(['n_base::of_load']);
    const ext = cg.getOutgoingEdgesFrom(cg.getNodesInFile('app.pbl/n_orders.sru').map((n) => n.id), ['extends']);
    expect(ext.map((e) => cg.getNode(e.target)!.name)).toEqual(['n_base']);
  });

  it('shows its source as text in codegraph_explore', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'n_orders.of_run' });
    const text = res.content?.[0]?.text ?? '';
    expect(text).toContain('public function integer of_run ();// Lädt die Aufträge');
    expect(text).not.toContain('\u0000');
  });

  it('is not reported as changed by the stale-answer check while it is unchanged', async () => {
    const files = cg.getFiles().filter((f) => f.path.endsWith('.sru'));
    expect(files).toHaveLength(2);
    const result = await validateAnswerFiles(root, files.map((f) => ({ path: f.path, contentHash: f.contentHash })));
    expect(result).toEqual({ stale: [], unchecked: [] });
  });
});
