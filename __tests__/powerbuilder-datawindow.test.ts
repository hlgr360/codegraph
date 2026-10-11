/**
 * A PowerBuilder DataWindow (`.srd`) is not PowerScript: a header, a long
 * layout of bands and fonts, and one `table(...)` block holding the columns and
 * the SQL. DataWindowExtractor reads that block (and the nested reports and
 * drop-down DataWindows the layout names), so a batch that does
 * `ds.dataobject = "d_x"` is linked to the tables and columns it works on.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { tablesInSql } from '../src/extraction/datawindow-extractor';

const crlf = (text: string): string => text.replace(/\n/g, '\r\n');

/**
 * A DataWindow shaped like a real export: the SQL spans lines, holds escaped
 * quotes and a `)` in a string, and the layout below it names two more
 * DataWindows.
 */
const dOrders = crlf(`HA$PBExportHeader$d_orders.srd
release 12;
datawindow(units=0 timer_interval=0 color=16777215 )
header(height=0 color="536870912" )
detail(height=76 color="536870912" )
table(column=(type=long update=yes updatewhereclause=yes key=yes name=order_id dbname="orders.order_id" )
 column=(type=char(30) update=yes updatewhereclause=yes name=customer dbname="orders.customer" )
 column=(type=decimal(2) name=total dbname="total" )
 retrieve="SELECT ~"ORDERS~".~"ORDER_ID~", o.customer, SUM(i.price) AS total
  FROM orders o, order_items i
  JOIN customers c ON c.id = o.customer_id
  WHERE o.id = :order_id AND o.note <> 'smile :)'" update="orders" updatewhere=1 updatekeyinplace=no arguments=(("order_id", number)) )
text(band=header alignment="2" text="Customer" border="0" x="9" y="8" height="64" width="400" name=t_1 )
column(band=detail id=2 alignment="0" tabsequence=10 border="5" x="9" y="4" height="64" width="400" format="[general]" name=customer visible="1" dddw.name=d_customer_lookup dddw.displaycolumn=name dddw.datacolumn=id )
report(band=detail dataobject="d_order_items" x="0" y="80" height="300" width="900" border="0" )
htmltable(border="1" )
`);

describe('DataWindowExtractor', () => {
  const result = extractFromSource('app.pbl/d_orders.srd', dOrders);
  const byName = (name: string) => result.nodes.find((n) => n.name === name);

  it('reads the DataWindow as a class named after its export header', () => {
    expect(result.errors).toEqual([]);
    expect(byName('d_orders')).toMatchObject({
      kind: 'component',
      language: 'powerbuilder',
      decorators: ['datawindow'],
      isExported: true,
    });
  });

  it('reads the columns with their type and database column', () => {
    const columns = result.nodes.filter((n) => n.kind === 'field');
    expect(columns.map((n) => n.name)).toEqual(['order_id', 'customer', 'total']);
    expect(byName('order_id')).toMatchObject({ qualifiedName: 'd_orders::order_id', signature: 'long ← orders.order_id', decorators: ['key'] });
    expect(byName('customer')?.signature).toBe('char(30) ← orders.customer');
    // A computed column has no database column of its own.
    expect(byName('total')?.signature).toBe('decimal(2)');
    const dw = byName('d_orders')!;
    const contained = result.edges.filter((e) => e.source === dw.id && e.kind === 'contains').map((e) => e.target);
    expect(contained).toEqual(columns.map((n) => n.id));
  });

  it('keeps the SQL whole, unescaped, with a ) in a string and a line break', () => {
    const sql = byName('d_orders')!.docstring!;
    expect(sql).toContain('SELECT "ORDERS"."ORDER_ID", o.customer');
    expect(sql).toContain("o.note <> 'smile :)'");
    expect(sql).not.toContain('~"');
    expect(sql).not.toContain('\r');
    expect(sql.split('\n')).toHaveLength(4);
  });

  it('names the tables read, the table updated and the arguments', () => {
    expect(byName('d_orders')?.signature).toBe(
      'datawindow (release 12) · reads orders, order_items, customers · updates orders · arguments order_id: number',
    );
  });

  it('spans the table block, not the layout below it', () => {
    const dw = byName('d_orders')!;
    const lines = dOrders.split('\r\n');
    expect(dw.startLine).toBe(lines.findIndex((l) => l.startsWith('table(')) + 1);
    expect(dw.endLine).toBe(lines.findIndex((l) => l.includes('arguments=')) + 1);
    expect(dw.endLine).toBeLessThan(lines.findIndex((l) => l.startsWith('text(')) + 1);
  });

  it('links the nested report and the column behind a drop-down to the DataWindows they name', () => {
    const refs = result.unresolvedReferences.map((r) => ({ from: result.nodes.find((n) => n.id === r.fromNodeId)?.name, name: r.referenceName, kind: r.referenceKind, language: r.language }));
    expect(refs).toEqual([
      { from: 'd_orders', name: 'd_order_items', kind: 'references', language: 'powerbuilder' },
      { from: 'customer', name: 'd_customer_lookup', kind: 'references', language: 'powerbuilder' },
    ]);
  });

  it('still reads a DataWindow without a table block', () => {
    const bare = extractFromSource('app.pbl/d_free.srd', crlf('HA$PBExportHeader$d_free.srd\nrelease 12;\ndatawindow(units=0 )\nhtmltable(border="1" )\n'));
    expect(bare.errors).toEqual([]);
    expect(bare.nodes.find((n) => n.kind === 'component')).toMatchObject({ name: 'd_free', signature: 'datawindow (release 12)' });
    expect(bare.nodes.filter((n) => n.kind === 'field')).toEqual([]);
  });

  it('survives a table block that never closes', () => {
    const broken = extractFromSource('app.pbl/d_cut.srd', 'HA$PBExportHeader$d_cut.srd\nrelease 12;\ntable(column=(type=long name=a dbname="t.a" )\n retrieve="select a from t');
    expect(broken.errors).toEqual([]);
    expect(broken.nodes.find((n) => n.kind === 'component')?.name).toBe('d_cut');
  });
});

describe('tablesInSql', () => {
  it('reads FROM lists, joins and schema-qualified names, once each', () => {
    expect(tablesInSql('select * from a x, b y join c on c.i = x.i left outer join dbo.D on 1=1 where x.k in (select k from a)')).toEqual(['a', 'b', 'c', 'dbo.D']);
  });

  it('reads the tables of a painted (PBSELECT) statement', () => {
    expect(tablesInSql('PBSELECT( VERSION(400) TABLE(NAME="ord" ) TABLE(NAME="ord_item" ) COLUMN(NAME="ord.id"))')).toEqual(['ord', 'ord_item']);
  });

  it('is not misled by a string, a comment or a quoted name', () => {
    expect(tablesInSql(`select 'from nowhere' as s /* from hidden */ -- join ghost
      from "Order Lines" ol`)).toEqual(['Order Lines']);
  });
});

describe('PowerScript that names a DataWindow', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pb-datawindow-'));
    const files: Record<string, string> = {
      'app.pbl/d_orders.srd': dOrders,
      'app.pbl/d_order_items.srd': crlf(`HA$PBExportHeader$d_order_items.srd
release 12;
table(column=(type=long name=item_id dbname="order_items.item_id" )
 retrieve="select item_id from order_items" )
`),
      'app.pbl/w_orders.srw': crlf(`global type w_orders from window
end type
type dw_list from datawindow within w_orders
string dataobject = "d_orders"
end type
global w_orders w_orders

public subroutine of_open ();dw_list.SetTransObject(SQLCA)
dw_list.dataobject = "D_ORDER_ITEMS"
// dw_list.dataobject = "d_commented_out"
dw_list.dataobject = "d_not_in_this_project"
end subroutine
`),
      'batch.pbl/n_batch.sru': crlf(`global type n_batch from nonvisualobject
end type
global n_batch n_batch

public function integer of_run ();datastore ds_work
string ls_name
ds_work = create datastore
ds_work.DataObject = "d_orders"
ds_work.DataObject = ls_name
return ds_work.Retrieve(1)
end function
`),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `from -> DataWindow` for every references edge into a DataWindow, out of a file's symbols. */
  const usesFrom = (file: string): string[] => {
    const ids = cg.getNodesInFile(file).map((n) => n.id);
    return cg
      .getOutgoingEdgesFrom(ids, ['references'])
      .map((e) => `${cg.getNode(e.source)!.qualifiedName} -> ${cg.getNode(e.target)!.name}`)
      .sort();
  };

  it('indexes the DataWindows, their columns and SQL', () => {
    const dw = cg.getNodesInFile('app.pbl/d_orders.srd').find((n) => n.kind === 'component')!;
    expect(dw.name).toBe('d_orders');
    expect(dw.docstring).toContain('FROM orders o');
    expect(cg.getNodesInFile('app.pbl/d_orders.srd').filter((n) => n.kind === 'field').map((n) => n.name)).toEqual(['order_id', 'customer', 'total']);
  });

  it("links a control's type block and a script to the DataWindow they name, whatever its case", () => {
    expect(usesFrom('app.pbl/w_orders.srw')).toEqual(['w_orders::of_open -> d_order_items', 'w_orders::dw_list -> d_orders'].sort());
  });

  it('links a batch object to its DataWindow, and not through a variable', () => {
    expect(usesFrom('batch.pbl/n_batch.sru')).toEqual(['n_batch::of_run -> d_orders']);
  });

  it('shows who uses a DataWindow', () => {
    const dw = cg.getNodesInFile('app.pbl/d_orders.srd').find((n) => n.kind === 'component')!;
    const users = cg.getIncomingEdgesTo([dw.id], ['references']).map((e) => cg.getNode(e.source)!.qualifiedName).sort();
    expect(users).toEqual(['n_batch::of_run', 'w_orders::dw_list']);
  });

  it('links a nested report and a drop-down to their DataWindows', () => {
    expect(usesFrom('app.pbl/d_orders.srd')).toEqual(['d_orders -> d_order_items']);
  });
});
