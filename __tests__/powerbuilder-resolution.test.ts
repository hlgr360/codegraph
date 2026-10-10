/**
 * PowerScript calls resolve the way PowerBuilder looks names up — without
 * regard to case, through the caller's class and what it inherits, outward
 * from a control's script to its window, and through the declared type of a
 * local, an argument, an instance variable or a global variable — never to a
 * same-named method of an unrelated object.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pb-resolution-'));
  const files: Record<string, string> = {
    'base.pbl/n_base.sru': `global type n_base from nonvisualobject
event type integer ue_refresh ( )
end type
global n_base n_base

forward prototypes
public function integer of_load (long al_id)
public function integer of_load (long al_id, string as_mode)
end prototypes

public function integer of_load (long al_id);return 1
end function

public function integer of_load (long al_id, string as_mode);return 1
end function
`,
    'base.pbl/n_cst_string.sru': `global type n_cst_string from nonvisualobject
end type
global n_cst_string n_cst_string

public function string of_Trim (string as_x);return as_x
end function
`,
    'base.pbl/n_cst_appmanager.sru': `global type n_cst_appmanager from nonvisualobject
end type
global n_cst_appmanager n_cst_appmanager

public function string of_GetFrameTitle ();return ""
end function
`,
    'app.pbl/app.sra': `global variables
n_cst_appmanager gnv_app
end variables

global type app from application
end type
global app app
`,
    'app.pbl/n_cst_orders.sru': `global type n_cst_orders from n_base
end type
global n_cst_orders n_cst_orders

type variables
protected n_cst_string inv_string
end variables

public function integer of_Run ();n_cst_string lnv_local
OF_LOAD(1)
super::of_load(2)
inv_string.of_trim("a")
lnv_local.OF_TRIM("b")
gnv_app.of_GetFrameTitle()
this.TriggerEvent("ue_refresh")
return 1
end function
`,
    'app.pbl/w_orders.srw': `global type w_orders from window
cb_ok cb_ok
end type
global w_orders w_orders

public subroutine of_save ();of_Validate()
end subroutine

public subroutine of_validate ();
end subroutine

type cb_ok from commandbutton within w_orders
end type

event clicked;of_save()
end event
`,
    'base.pbl/u_button.sru': `global type u_button from commandbutton
end type
global u_button u_button

public subroutine of_flash ();
end subroutine
`,
    'app.pbl/w_named.srw': `global type w_named from window
u_button u_button
end type
global w_named w_named

type u_button from u_button within w_named
end type

event clicked;of_flash()
end event
`,
    'base.pbl/n_ping.sru': `global type n_ping from nonvisualobject
end type
global n_ping n_ping

public function integer of_ping (long al_a);return 1
end function

public function integer of_ping (long al_a, long al_b);return 2
end function
`,
    'app.pbl/n_pinger.sru': `global type n_pinger from nonvisualobject
end type
global n_pinger n_pinger

public subroutine of_go ();lnv_unknown.of_ping(1, 2)
end subroutine
`,
    'other.pbl/n_unrelated.sru': `global type n_unrelated from nonvisualobject
end type
global n_unrelated n_unrelated

public function integer of_trim (string as_x);return 1
end function

public function integer of_save ();return 1
end function
`,
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

/** `Owner::member` of every edge of `kind` out of a file. */
function edgesFrom(file: string, kind: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === kind)
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('PowerBuilder resolution', () => {
  it('links a class to its ancestor, whatever its case', () => {
    expect(edgesFrom('app.pbl/n_cst_orders.sru', 'extends')).toEqual(['n_base']);
  });

  it('resolves calls through the class chain and declared receiver types', () => {
    expect(edgesFrom('app.pbl/n_cst_orders.sru', 'calls')).toEqual([
      'n_base::of_load', // OF_LOAD(1), inherited
      'n_base::of_load', // super::of_load(2)
      'n_base::ue_refresh', // TriggerEvent("ue_refresh"), a declared event
      'n_cst_appmanager::of_GetFrameTitle', // through the global gnv_app
      'n_cst_string::of_Trim', // inv_string, an instance variable
      'n_cst_string::of_Trim', // lnv_local, a local
    ]);
  });

  it("looks outward from a control's script to its window", () => {
    expect(edgesFrom('app.pbl/w_orders.srw', 'calls')).toEqual(['w_orders::of_save', 'w_orders::of_validate']);
  });

  it('inherits from the other type when a control is named after its ancestor', () => {
    const control = cg.getNodesInFile('app.pbl/w_named.srw').find((n) => n.kind === 'class' && n.name === 'u_button')!;
    const ext = cg.getOutgoingEdgesFrom([control.id], ['extends']).map((e) => cg.getNode(e.target)!);
    expect(ext.map((n) => n.filePath)).toEqual(['base.pbl/u_button.sru']);
    expect(edgesFrom('app.pbl/w_named.srw', 'calls')).toEqual(['u_button::of_flash']);
  });

  it('picks the overload by argument count when the receiver type is unknown', () => {
    const ids = cg.getNodesInFile('app.pbl/n_pinger.sru').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids, ['calls']).map((e) => cg.getNode(e.target)!);
    expect(targets.map((n) => n.signature)).toEqual(['public function integer of_ping (long al_a, long al_b)']);
  });

  it('never links a same-named method of an unrelated object', () => {
    const ids = cg.getNodesInFile('other.pbl/n_unrelated.sru').map((n) => n.id);
    expect(cg.getIncomingEdgesTo(ids, ['calls'])).toEqual([]);
  });
});

describe('PowerBuilder in codegraph_explore', () => {
  it('finds the call path among names however the query cases them', async () => {
    // The scripts declare `clicked` / `of_save` / `of_validate`; an agent
    // copies the casing a caller used, or capitalizes it.
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'cb_ok.Clicked OF_SAVE of_Validate' });
    const text = res.content?.[0]?.text ?? '';
    expect(text).toContain('**Flow (call path among the symbols you queried)**');
    expect(text).toMatch(/1\. clicked \(app\.pbl\/w_orders\.srw:\d+\)/);
    expect(text).toMatch(/2\. of_save \(app\.pbl\/w_orders\.srw:\d+\)/);
    expect(text).toMatch(/3\. of_validate \(app\.pbl\/w_orders\.srw:\d+\)/);
  });
});
