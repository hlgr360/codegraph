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

describe('PowerScript that names a DataWindow without a literal', () => {
  let root = '';
  let cg: CodeGraph;

  const bareDw = (name: string): string => crlf(`HA$PBExportHeader$${name}.srd\nrelease 12;\ntable(column=(type=long name=id dbname="t.id" )\n retrieve="select id from t" )\n`);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pb-datawindow-value-'));
    const files: Record<string, string> = {
      'app.pbl/d_orders.srd': bareDw('d_orders'),
      'app.pbl/d_order_items.srd': bareDw('d_order_items'),
      'app.pbl/d_lookup.srd': bareDw('d_lookup'),
      // A datastore that sets its DataWindow, and a subclass that inherits it.
      'app.pbl/u_ds_orders.sru': crlf(`global type u_ds_orders from datastore
string dataobject = "d_orders"
end type
global u_ds_orders u_ds_orders
`),
      // A reusable base with a placeholder DataWindow, and a concrete subclass.
      'app.pbl/u_ds_base.sru': crlf(`global type u_ds_base from datastore
string dataobject = "d_lookup"
end type
global u_ds_base u_ds_base
`),
      'app.pbl/u_ds_leaf.sru': crlf(`global type u_ds_leaf from u_ds_base
end type
global u_ds_leaf u_ds_leaf
`),
      // What the sync dialog receives: a structure holding the datastores.
      'app.pbl/s_parm.srs': crlf(`global type s_parm from structure
	u_ds_orders modify_ds
	u_ds_leaf sub_ds
end type
`),
      'app.pbl/n_cst_constants.sru': crlf(`global type n_cst_constants from nonvisualobject
end type
global n_cst_constants n_cst_constants

type variables
constant string c_dw_items = "d_order_items"
end variables
`),
      'app.pbl/app.sra': crlf(`global variables
n_cst_constants gnv_const
end variables

global type app from application
end type
global app app
`),
      'app.pbl/w_show.srw': crlf(`global type w_show from window
end type
global w_show w_show

type dw_work from datawindow within w_show
string dataobject = "d_order_items"
end type

type variables
constant string c_local = 'd_lookup'
string is_unknown
end variables

public subroutine of_param (s_parm astr_parm);dw_1.dataobject = astr_parm.modify_ds.dataobject
end subroutine

public subroutine of_inherited (s_parm astr_parm);dw_1.dataobject = astr_parm.sub_ds.dataobject
end subroutine

public subroutine of_local ();u_ds_orders lds_in
dw_1.dataobject = lds_in.dataobject
end subroutine

public subroutine of_other_object_constant ();dw_1.dataobject = gnv_const.c_dw_items
end subroutine

public subroutine of_own_constant ();dw_1.dataobject = c_local
end subroutine

public subroutine of_assigned_name ();string ls_name
ls_name = 'd_order_items'
dw_1.dataobject = ls_name
end subroutine

public subroutine of_generic_base ();u_ds_base lds_base
dw_1.dataobject = lds_base.dataobject
end subroutine

public subroutine of_own_control ();dw_1.dataobject = dw_work.dataobject
end subroutine

public subroutine of_single_quoted ();dw_1.dataobject = 'd_orders'
end subroutine

public subroutine of_unknown ();dw_1.dataobject = is_unknown
end subroutine
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

  /** The DataWindows each function of the window points at, by function. */
  const dataWindowsOf = (): Record<string, string[]> => {
    const nodes = cg.getNodesInFile('app.pbl/w_show.srw');
    const out: Record<string, string[]> = {};
    for (const fn of nodes.filter((n) => n.kind === 'method')) {
      out[fn.name] = cg
        .getOutgoingEdgesFrom([fn.id], ['references'])
        .map((e) => cg.getNode(e.target)!)
        .filter((n) => n.kind === 'component')
        .map((n) => n.name)
        .sort();
    }
    return out;
  };

  it('reads the DataWindow a structure parameter\'s datastore sets (the dialog case)', () => {
    expect(dataWindowsOf().of_param).toEqual(['d_orders']);
  });

  it('follows a datastore subclass up to the DataWindow it inherits', () => {
    expect(dataWindowsOf().of_inherited).toEqual(['d_lookup']);
  });

  it("does not read a reusable base's DataWindow: a subclass or a run-time value may differ", () => {
    expect(dataWindowsOf().of_generic_base).toEqual([]);
  });

  it('reads the DataWindow of a control written in the same file', () => {
    expect(dataWindowsOf().of_own_control).toEqual(['d_order_items']);
  });

  it('types a local by its declaration', () => {
    expect(dataWindowsOf().of_local).toEqual(['d_orders']);
  });

  it("reads a constant another object declares, through a global variable", () => {
    expect(dataWindowsOf().of_other_object_constant).toEqual(['d_order_items']);
  });

  it("reads the object's own constant, whatever its quote", () => {
    expect(dataWindowsOf().of_own_constant).toEqual(['d_lookup']);
  });

  it('reads a name the same function assigns to a variable first', () => {
    expect(dataWindowsOf().of_assigned_name).toEqual(['d_order_items']);
  });

  it('reads a single-quoted literal', () => {
    expect(dataWindowsOf().of_single_quoted).toEqual(['d_orders']);
  });

  it('links nothing when no DataWindow name can be found', () => {
    expect(dataWindowsOf().of_unknown).toEqual([]);
  });
});

describe('A dialog that receives its DataWindow through a structure', () => {
  let root = '';
  let cg: CodeGraph;

  const bareDw = (name: string): string => crlf(`HA$PBExportHeader$${name}.srd\nrelease 12;\ntable(column=(type=long name=id dbname="t.id" )\n retrieve="select id from t" )\n`);
  const datastore = (name: string, dw: string): string => crlf(`global type ${name} from datastore\nstring dataobject = "${dw}"\nend type\nglobal ${name} ${name}\n`);
  // Reads the structure's datastore: which DataWindow depends on who opened it.
  const dialog = (name: string): string => crlf(`global type ${name} from window
end type
global ${name} ${name}

public subroutine of_show_modify ();s_carrier lstr
lstr = Message.PowerObjectParm
dw_1.dataobject = lstr.modify_ds.dataobject
end subroutine

public subroutine of_show_delete ();s_carrier lstr
lstr = Message.PowerObjectParm
dw_1.dataobject = lstr.delete_ds.dataobject
end subroutine
`);
  const opener = (name: string, window: string, body: string): string => crlf(`global type ${name} from nonvisualobject
end type
global ${name} ${name}

public subroutine of_open ();s_carrier lstr_parm
${body}
OpenWithParm(${window}, lstr_parm)
end subroutine
`);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pb-datawindow-flow-'));
    const files: Record<string, string> = {
      'app.pbl/d_orders.srd': bareDw('d_orders'),
      'app.pbl/d_items.srd': bareDw('d_items'),
      'app.pbl/d_lookup.srd': bareDw('d_lookup'),
      'app.pbl/d_third.srd': bareDw('d_third'),
      'app.pbl/u_ds_orders.sru': datastore('u_ds_orders', 'd_orders'),
      'app.pbl/u_ds_items.sru': datastore('u_ds_items', 'd_items'),
      'app.pbl/u_ds_lookup.sru': datastore('u_ds_lookup', 'd_lookup'),
      'app.pbl/u_ds_third.sru': datastore('u_ds_third', 'd_third'),
      // The carrier: its fields are the system datastore, so the type says nothing.
      'app.pbl/s_carrier.srs': crlf(`global type s_carrier from structure
	datastore modify_ds
	datastore delete_ds
end type
`),
      'app.pbl/w_dialog.srw': dialog('w_dialog'),
      'app.pbl/w_other.srw': dialog('w_other'),
      'app.pbl/w_nobody.srw': dialog('w_nobody'),
      // Two openers of w_dialog, each with its own datastores.
      'app.pbl/n_open_a.sru': opener('n_open_a', 'w_dialog', `u_ds_orders ds_m
u_ds_items ds_d
ds_m = create u_ds_orders
ds_d = create u_ds_items
lstr_parm.modify_ds = ds_m
lstr_parm.delete_ds = ds_d`),
      'app.pbl/n_open_b.sru': opener('n_open_b', 'w_dialog', `u_ds_lookup ds_o
ds_o = create u_ds_lookup
lstr_parm.modify_ds = ds_o`),
      // An unrelated flow through the same structure: it feeds w_other, never w_dialog.
      'app.pbl/n_open_other.sru': opener('n_open_other', 'w_other', `u_ds_third ds_t
ds_t = create u_ds_third
lstr_parm.modify_ds = ds_t`),
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

  /** The DataWindows a dialog's function points at through the structure, with how each link was made. */
  const flowFrom = (file: string, fn: string): Array<{ dw: string; by?: unknown; via?: unknown; opener?: unknown }> => {
    const node = cg.getNodesInFile(file).find((n) => n.kind === 'method' && n.name === fn)!;
    return cg
      .getOutgoingEdgesFrom([node.id], ['references'])
      .filter((e) => e.provenance === 'heuristic')
      .map((e) => ({ dw: cg.getNode(e.target)!.name, by: e.metadata?.synthesizedBy, via: e.metadata?.via, opener: e.metadata?.opener }))
      .sort((a, b) => a.dw.localeCompare(b.dw));
  };

  it('links the dialog to the DataWindow its opener puts in the field, and says where it came from', () => {
    expect(flowFrom('app.pbl/w_dialog.srw', 'of_show_delete')).toEqual([
      { dw: 'd_items', by: 'pb-dataobject-flow', via: 's_carrier.delete_ds', opener: 'of_open' },
    ]);
  });

  it('counts every opener: the dialog can show any of them', () => {
    expect(flowFrom('app.pbl/w_dialog.srw', 'of_show_modify').map((l) => l.dw)).toEqual(['d_lookup', 'd_orders']);
  });

  it('keeps the flow of another dialog out', () => {
    // w_other is fed by n_open_other only; its datastore never reaches w_dialog.
    expect(flowFrom('app.pbl/w_other.srw', 'of_show_modify').map((l) => l.dw)).toEqual(['d_third']);
    expect(flowFrom('app.pbl/w_dialog.srw', 'of_show_modify').map((l) => l.dw)).not.toContain('d_third');
  });

  it('is specific to the field: an opener that fills only modify_ds says nothing about delete_ds', () => {
    expect(flowFrom('app.pbl/w_other.srw', 'of_show_delete')).toEqual([]);
  });

  it('links nothing for a dialog nobody opens', () => {
    expect(flowFrom('app.pbl/w_nobody.srw', 'of_show_modify')).toEqual([]);
  });
});

describe('A DataWindow control handed down through a structure', () => {
  let root = '';
  let cg: CodeGraph;

  const bareDw = (name: string): string => crlf(`HA$PBExportHeader$${name}.srd\nrelease 12;\ntable(column=(type=long name=id dbname="t.id" )\n retrieve="select id from t" )\n`);
  /** A DataWindow control class that fills `field` of the structure with itself, from a function of its own. */
  const control = (name: string, parent: string, dw: string | null, struct: string, field: string, extra = ''): string => crlf(`global type ${name} from ${parent}
${dw ? `string dataobject = "${dw}"\n` : ''}end type
global ${name} ${name}

public subroutine of_validate ();${struct} lstr
${extra}lstr.${field} = THIS
end subroutine
`);
  /** A helper that reads the DataWindow of the control it is handed. */
  const helper = (name: string, struct: string, field: string): string => crlf(`global type ${name} from nonvisualobject
end type
global ${name} ${name}

public subroutine of_copy (ref ${struct} check);datastore ds_a
ds_a.dataobject = check.${field}.dataobject
end subroutine
`);
  const struct = (name: string, field: string): string => crlf(`global type ${name} from structure
	string msg
	datawindow ${field}
end type
`);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pb-datawindow-control-'));
    const files: Record<string, string> = {
      'app.pbl/d_address.srd': bareDw('d_address'),
      'app.pbl/d_person.srd': bareDw('d_person'),
      'app.pbl/d_future.srd': bareDw('d_future'),
      'app.pbl/d_shared.srd': bareDw('d_shared'),
      // The private carrier: two control classes fill it, one has a subclass with its own DataWindow.
      'app.pbl/s_check.srs': struct('s_check', 'in_dw'),
      'app.pbl/u_dw_address.sru': control('u_dw_address', 'datawindow', 'd_address', 's_check', 'in_dw'),
      'app.pbl/u_dw_person.sru': control('u_dw_person', 'datawindow', 'd_person', 's_check', 'in_dw'),
      'app.pbl/u_dw_future.sru': crlf(`global type u_dw_future from u_dw_address
string dataobject = "d_future"
end type
global u_dw_future u_dw_future
`),
      // Another structure with a field of the same name, filled by a control that is no business of s_check's.
      'app.pbl/s_other.srs': struct('s_other', 'in_dw'),
      'app.pbl/u_dw_other.sru': control('u_dw_other', 'datawindow', 'd_shared', 's_other', 'in_dw'),
      'app.pbl/n_country.sru': helper('n_country', 's_check', 'in_dw'),
      // A carrier thirteen unrelated classes fill is shared, and says nothing about its reader.
      'app.pbl/s_shared.srs': struct('s_shared', 'in_dw'),
      'app.pbl/n_shared_reader.sru': helper('n_shared_reader', 's_shared', 'in_dw'),
      // A field nothing fills.
      'app.pbl/s_empty.srs': struct('s_empty', 'in_dw'),
      'app.pbl/n_empty_reader.sru': helper('n_empty_reader', 's_empty', 'in_dw'),
    };
    for (let i = 1; i <= 13; i++) files[`app.pbl/u_dw_p${i}.sru`] = control(`u_dw_p${i}`, 'datawindow', 'd_shared', 's_shared', 'in_dw');
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

  const flowOf = (file: string): Array<{ dw: string; via: unknown; by: unknown }> => {
    const fn = cg.getNodesInFile(file).find((n) => n.kind === 'method' && n.name === 'of_copy')!;
    return cg
      .getOutgoingEdgesFrom([fn.id], ['references'])
      .filter((e) => e.provenance === 'heuristic')
      .map((e) => ({ dw: cg.getNode(e.target)!.name, via: e.metadata?.via, by: e.metadata?.synthesizedBy }))
      .sort((a, b) => a.dw.localeCompare(b.dw));
  };

  it("links the reader to the DataWindow of every class that fills the field, and of its subclasses", () => {
    expect(flowOf('app.pbl/n_country.sru')).toEqual([
      { dw: 'd_address', via: 's_check.in_dw', by: 'pb-dataobject-flow' },
      { dw: 'd_future', via: 's_check.in_dw', by: 'pb-dataobject-flow' }, // u_dw_future extends u_dw_address
      { dw: 'd_person', via: 's_check.in_dw', by: 'pb-dataobject-flow' },
    ]);
  });

  it('does not count a control that fills another structure\'s field of the same name', () => {
    const dws = flowOf('app.pbl/n_country.sru').map((l) => l.dw);
    expect(dws).toContain('d_address'); // the link exists, so the absence below means something
    expect(dws).not.toContain('d_shared');
  });

  it('leaves a shared carrier alone: thirteen unrelated classes fill it', () => {
    expect(flowOf('app.pbl/n_shared_reader.sru')).toEqual([]);
  });

  it('links nothing when no control fills the field', () => {
    expect(flowOf('app.pbl/n_empty_reader.sru')).toEqual([]);
  });
});
