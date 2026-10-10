/**
 * PowerBuilder (PowerScript) extraction.
 *
 * One exported object source (`.sra` application, `.srw` window, `.sru` user
 * object, `.srm` menu, `.srf` global function, `.srs` structure) parses as a
 * FLAT list of sections under `class_file`: the object's `type … from …`
 * block, its variable sections, its functions, its events — and then one more
 * `type cb_ok from u_cb within w_main` block per control, each followed by
 * that control's own events. Nothing nests: an event belongs to the type block
 * written last above it, a function to the file's main object. So the whole
 * file is walked here, in order, with that state; the generic walker never
 * sees it.
 *
 * Bodies get their own walk (`walkBody`) because PowerScript's calls name
 * their target in shapes the generic call path cannot read:
 *   - `call super::open` / `call u_dw::constructor` — the ancestor's event;
 *   - `super::of_init()` — the ancestor's function;
 *   - `dw_1.event pfc_retrieve()` / `inv.dynamic of_x()` — event and dynamic
 *     calls, which still name the method they reach;
 *   - `this.TriggerEvent("ue_close")` / `PostEvent("ue_x")` — an event fired
 *     by its name in a string literal, linked like a call to it;
 *   - `create n_cst_x` / `create using "n_cst_x"` — instantiation;
 *   - `Open(w_sheet)` / `OpenSheet(lw, "w_sheet", …)` — opening a window, the
 *     way a PowerBuilder app moves from screen to screen.
 *
 * Identifiers are case-insensitive (see CASE_INSENSITIVE_LANGUAGES), so the
 * class map keys are lowercased; node names keep their written spelling.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind, ReferenceKind } from '../../types';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/** Built-in functions that fire an event named by their first argument. */
const FIRE_EVENT_FUNCTIONS = new Set(['triggerevent', 'postevent']);
/** Built-in functions that open a window / user object named by an argument. */
const OPEN_FUNCTIONS = new Set([
  'open', 'openwithparm', 'opensheet', 'opensheetwithparm',
  'openuserobject', 'openuserobjectwithparm', 'opentab', 'opentabwithparm',
]);
/**
 * `event cb_ok::clicked;` — a menu item's or a control's event written from
 * the object that holds it. The grammar has no rule for the `::` there and
 * loses the whole script, so the `::` becomes `$$` before parsing (same
 * length, and `$` is an identifier character): `cb_ok$$clicked` is one name,
 * split back apart in handleEvent.
 */
const SCOPED_EVENT_RE = /^([ \t]*event[ \t]+(?:type[ \t]+[\w$#%-]+[ \t]+)?[A-Za-z_#][\w$#%-]*)::(?=[A-Za-z_#])/gim;
const SCOPED_EVENT_MARK = '$$';

/** A string argument that can only be a type name. */
const TYPE_NAME_RE = /^[A-Za-z_][\w$#%-]*$/;

function child(node: SyntaxNode | null | undefined, type: string): SyntaxNode | null {
  if (!node) return null;
  for (const c of node.namedChildren) if (c.type === type) return c;
  return null;
}

function descendant(node: SyntaxNode | null | undefined, type: string): SyntaxNode | null {
  if (!node) return null;
  return node.descendantsOfType(type)[0] ?? null;
}

/** Collapse whitespace runs so multi-line headers read as one signature. */
function collapse(text: string, cap = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? flat.slice(0, cap - 1) + '…' : flat;
}

/** The text of a header up to the `;` that starts its body on the same line. */
function headerText(node: SyntaxNode, source: string): string {
  return collapse(getNodeText(node, source).replace(/;[\s\S]*$/, ''));
}

/** The content of a string literal, or null for anything else. */
function stringContent(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  const lit = node.type === 'string_literal' ? node : null;
  if (!lit) {
    // r_value_expression → string_literal, nothing else around it.
    if (node.namedChildCount !== 1) return null;
    return stringContent(node.namedChildren[0] ?? null, source);
  }
  const content = child(lit, 'string_content');
  return content ? getNodeText(content, source) : '';
}

function visibilityOf(node: SyntaxNode | null): Node['visibility'] {
  const mod = child(node, 'access_modifier');
  const kw = mod?.namedChildren[0]?.type ?? '';
  if (kw.startsWith('private')) return 'private';
  if (kw.startsWith('protected')) return 'protected';
  if (kw.startsWith('public')) return 'public';
  return undefined;
}

interface FileState {
  ctx: ExtractorContext;
  /** The object the file defines — the first top-level type block. */
  main: Node | null;
  /** Whether `main` is the file's `global type` (a later one replaces a local). */
  mainIsGlobal: boolean;
  /** The type block written last: the owner of the events that follow it. */
  current: Node | null;
  /** Every type block in the file, by lowercased name. */
  classes: Map<string, Node>;
  /** Class id → the ancestor it is declared `from`. */
  ancestors: Map<string, string>;
  /** Class id → the class it is declared `within` (a control's window). */
  containers: Map<string, Node>;
  /** User events declared in a type block, until a script defines them. */
  declaredEvents: Map<string, { owner: Node; decl: SyntaxNode }>;
  /** A `.srf` global-function file: its functions are free functions. */
  functionFile: boolean;
  /** The script being walked: its locals and arguments, lowercased → declared type. */
  locals: Map<string, string>;
}

function addRef(
  st: FileState,
  fromNodeId: string,
  referenceName: string,
  referenceKind: ReferenceKind,
  at: SyntaxNode,
): void {
  if (!referenceName) return;
  st.ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
  });
}

function createIn(
  st: FileState,
  scope: Node | null,
  kind: NodeKind,
  name: string,
  node: SyntaxNode,
  extra?: Partial<Node>,
): Node | null {
  if (scope) st.ctx.pushScope(scope.id);
  const created = st.ctx.createNode(kind, name, node, extra);
  if (scope) st.ctx.popScope();
  return created;
}

// --- Type blocks -----------------------------------------------------------

function handleClassType(def: SyntaxNode, st: FileState): void {
  const { source } = st.ctx;
  const stmt = child(def, 'class_type_definition_statement');
  const nameNode = child(stmt, 'class_type_name');
  if (!stmt || !nameNode) return;
  const name = getNodeText(nameNode, source);
  const ancestorNode = child(stmt, 'ancenstor_type_name');
  // `from m_master\`m_file` — the `m_file` item declared inside `m_master`,
  // which an inherited menu's or window's own `m_file` descends from.
  const ancestorParent = child(stmt, 'ancenstor_type_name_parent');
  const ancestor = ancestorNode
    ? (ancestorParent ? `${getNodeText(ancestorParent, source)}\`` : '') + getNodeText(ancestorNode, source)
    : '';
  const withinNode = child(stmt, 'parent_class');
  const within = withinNode ? getNodeText(withinNode, source) : '';
  const isGlobal = child(stmt, 'global_keyword') !== null;

  // `global type f_x from function_object` only wraps a global function.
  if (ancestor.toLowerCase() === 'function_object') {
    st.functionFile = true;
    return;
  }

  const container = within ? st.classes.get(within.toLowerCase()) ?? st.main : null;
  const kind: NodeKind = ancestor.toLowerCase() === 'structure' ? 'struct' : 'class';
  const cls = createIn(st, container, kind, name, def, {
    signature: headerText(stmt, source),
    isExported: isGlobal,
  });
  if (!cls) return;

  st.classes.set(name.toLowerCase(), cls);
  // The file's object is its `global type`; a local structure or control
  // written above it (`type str_x from structure within n_x`) is not.
  if (!st.main || (isGlobal && !st.mainIsGlobal)) {
    st.main = cls;
    st.mainIsGlobal = isGlobal;
  }
  // Scripts that follow belong to the object or control declared last — a
  // structure has none.
  if (kind === 'class') st.current = cls;
  if (container) st.containers.set(cls.id, container);
  if (ancestor && kind === 'class') {
    st.ancestors.set(cls.id, ancestor);
    addRef(st, cls.id, ancestor, 'extends', ancestorNode!);
  }

  const body = child(def, 'class_type_definition_statement_body');
  if (!body) return;
  for (const member of body.namedChildren) {
    if (member.type === 'event_declaration') {
      const eventName = child(member, 'event_name');
      if (eventName) {
        st.declaredEvents.set(`${cls.id}\0${getNodeText(eventName, source).toLowerCase()}`, { owner: cls, decl: member });
      }
    } else if (member.type === 'inner_class_variable_declaration' && kind === 'struct') {
      handleVariableDeclaration(member, st, cls, 'field', undefined);
    }
  }
}

function handleStructure(def: SyntaxNode, st: FileState): void {
  const { source } = st.ctx;
  const stmt = child(def, 'structure_definition_statement');
  const nameNode = child(stmt, 'structure_name');
  if (!stmt || !nameNode) return;
  const struct = createIn(st, null, 'struct', getNodeText(nameNode, source), def, {
    signature: headerText(stmt, source),
    isExported: child(stmt, 'global_keyword') !== null,
  });
  if (!struct) return;
  if (!st.main) st.main = struct;
  const body = child(def, 'structure_definition_body');
  for (const field of body?.namedChildren ?? []) {
    if (field.type !== 'structure_field') continue;
    const fieldName = child(field, 'field_name');
    const type = child(field, 'type');
    if (!fieldName) continue;
    const typeText = type ? getNodeText(type, source) : '';
    const created = createIn(st, struct, 'field', getNodeText(fieldName, source), field, {
      signature: collapse(`${typeText} ${getNodeText(fieldName, source)}`),
    });
    if (created && type) typeRef(st, created.id, type);
  }
}

// --- Variables -------------------------------------------------------------

/** A reference to a declared type that is not a PowerScript primitive. */
function typeRef(st: FileState, fromNodeId: string, typeNode: SyntaxNode): void {
  const custom = typeNode.type === 'custom_type' ? typeNode : descendant(typeNode, 'custom_type');
  if (custom) addRef(st, fromNodeId, getNodeText(custom, st.ctx.source), 'references', custom);
}

/**
 * One declaration statement (`constant integer DEFAULT = 0`,
 * `n_cst_svc inv_a, inv_b`). Each declared name becomes a node of `kind`
 * (a `constant` when the statement says so).
 */
function handleVariableDeclaration(
  decl: SyntaxNode,
  st: FileState,
  scope: Node | null,
  kind: NodeKind,
  visibility: Node['visibility'],
  isExported?: boolean,
): void {
  const { source } = st.ctx;
  const local = decl.type === 'local_variable_declaration' ? decl : descendant(decl, 'local_variable_declaration');
  if (!local) return;
  const type = child(local, 'variable_type');
  const typeText = type ? getNodeText(type, source) : '';
  const isConstant = child(local, 'constant_keyword') !== null;
  const ownVisibility = visibilityOf(decl) ?? visibility;
  const list = child(local, 'variable_declaration_list');
  for (const v of list?.namedChildren ?? []) {
    if (v.type !== 'variable_declaration') continue;
    const nameNode = child(v, 'variable_name');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, source);
    const init = child(v, 'initial_value');
    const created = createIn(st, scope, isConstant ? 'constant' : kind, name, v, {
      signature: collapse(`${isConstant ? 'constant ' : ''}${typeText} ${name}${init ? ` = ${getNodeText(init, source)}` : ''}`),
      visibility: ownVisibility,
      isExported,
    });
    if (created && type) typeRef(st, created.id, type);
  }
}

/** `type variables` / `shared variables` / `global variables` sections. */
function handleVariablesSection(section: SyntaxNode, st: FileState): void {
  const isGlobal = section.type === 'global_variables_section';
  const scope = isGlobal ? null : st.main;
  const kind: NodeKind = isGlobal ? 'variable' : 'field';
  let visibility: Node['visibility'] = isGlobal ? undefined : 'public';
  const visit = (node: SyntaxNode): void => {
    for (const c of node.namedChildren) {
      if (c.type === 'access_section') {
        visibility = visibilityOf(c) ?? visibility;
      } else if (
        c.type === 'instance_variable_declaration' ||
        c.type === 'shared_variables_section_statement' ||
        c.type === 'local_variable_declaration_statement'
      ) {
        handleVariableDeclaration(c, st, scope, kind, visibility, isGlobal || undefined);
      } else if (c.type.endsWith('_body')) {
        visit(c);
      }
    }
  };
  visit(section);
}

// --- Functions and events --------------------------------------------------

/** `function long GetTickCount() library "kernel32.dll"` — declared, not defined. */
function handleExternalPrototypes(section: SyntaxNode, st: FileState): void {
  const { source } = st.ctx;
  for (const ext of section.namedChildren) {
    if (ext.type !== 'external_function_prototype') continue;
    const proto = child(ext, 'function_prototype');
    const nameNode = child(proto, 'function_name') ?? child(proto, 'subroutine_name');
    if (!nameNode) continue;
    createIn(st, st.main, st.main ? 'method' : 'function', getNodeText(nameNode, source), ext, {
      signature: collapse(getNodeText(ext, source)),
      visibility: visibilityOf(proto),
    });
  }
}

function handleFunction(def: SyntaxNode, st: FileState): void {
  const { source } = st.ctx;
  const header = child(def, 'function_definition_statement') ?? child(def, 'subroutine_definition_statement');
  const nameNode = child(header, 'function_name') ?? child(header, 'subroutine_name');
  if (!header || !nameNode) return;
  const isGlobal = st.functionFile || child(header, 'global_keyword') !== null;
  const owner = isGlobal ? null : st.main;
  const fn = createIn(st, owner, owner ? 'method' : 'function', getNodeText(nameNode, source), def, {
    signature: headerText(header, source),
    visibility: visibilityOf(header),
    isExported: isGlobal || undefined,
  });
  if (!fn) return;
  const block = child(def, 'function_definition_block') ?? child(def, 'subroutine_definition_block');
  collectLocals(header, block, st);
  if (block) walkBody(block, fn, owner, st);
}

/** `event clicked;…end event` — a script on the type block written above it. */
function handleEvent(def: SyntaxNode, st: FileState): void {
  const { source } = st.ctx;
  const stmt = child(def, 'event_definition_statement');
  const decl = child(stmt, 'event_declaration');
  const nameNode = child(decl, 'event_name');
  if (!stmt || !nameNode) return;
  let name = getNodeText(nameNode, source);
  let owner = st.current ?? st.main;
  // `event cb_ok::clicked` (rewritten `cb_ok$$clicked`, see SCOPED_EVENT_RE)
  // names the control or menu item it belongs to.
  const mark = name.indexOf(SCOPED_EVENT_MARK);
  if (mark > 0) {
    owner = st.classes.get(name.slice(0, mark).toLowerCase()) ?? owner;
    name = name.slice(mark + SCOPED_EVENT_MARK.length);
  }
  if (owner) st.declaredEvents.delete(`${owner.id}\0${name.toLowerCase()}`);
  const ev = createIn(st, owner, 'method', name, def, {
    signature: headerText(decl ?? stmt, source),
    decorators: ['event'],
  });
  if (!ev) return;
  const block = child(def, 'event_definition_block');
  collectLocals(decl, block, st);
  if (block) walkBody(block, ev, owner, st);
}

/** `on w_main.create … end on` — the generated constructor / destructor script. */
function handleOnEvent(def: SyntaxNode, st: FileState): void {
  const { source } = st.ctx;
  const stmt = child(def, 'on_event_definition_statement');
  if (!stmt) return;
  const m = /^on\s+(?:([\w$#%-]+)\.)?([\w$#%-]+)/i.exec(getNodeText(stmt, source).trim());
  if (!m) return;
  const target = m[1] ? st.classes.get(m[1].toLowerCase()) : undefined;
  const owner = target ?? st.main;
  const ev = createIn(st, owner, 'method', m[2]!, def, {
    signature: collapse(getNodeText(stmt, source)),
    decorators: ['event'],
  });
  if (!ev) return;
  const block = child(def, 'on_event_definition_block');
  collectLocals(null, block, st);
  if (block) walkBody(block, ev, owner, st);
}

// --- Bodies ----------------------------------------------------------------

/** The ancestor a `super::` inside `owner` reaches. */
function superOf(owner: Node | null, st: FileState): string | undefined {
  return owner ? st.ancestors.get(owner.id) : undefined;
}

/**
 * Written for a receiver whose type cannot be read off the source — a call's
 * result (`gnv_app.of_GetFrame().of_x()`), an array element. The resolver then
 * links only a method name no other project method shares, and never reads a
 * call it cannot type as one on the caller's own class.
 */
const UNTYPED_RECEIVER = '?';

/**
 * The receiver path of an expression, as the resolver types it link by link:
 * `inv_svc`, `lv_1.inv_datasource`; a local or argument becomes its declared
 * type (`n_cst_string lnv_string` makes `lnv_string.of_x()` `n_cst_string.of_x`),
 * `this.` is dropped, `super` is the ancestor, `parent` the control's window.
 * '' for `this` itself; UNTYPED_RECEIVER for anything else.
 */
function receiverPath(node: SyntaxNode, owner: Node | null, st: FileState): string {
  switch (node.type) {
    case 'this_keyword':
      return '';
    case 'super_keyword':
      return superOf(owner, st) ?? UNTYPED_RECEIVER;
    case 'parent_keyword': {
      const container = owner ? st.containers.get(owner.id) : undefined;
      return container?.name ?? UNTYPED_RECEIVER;
    }
    case 'identifier_expression': {
      const variable = getNodeText(node, st.ctx.source).trim();
      return st.locals.get(variable.toLowerCase()) ?? variable;
    }
    case 'object': {
      const inner = node.namedChildren[0];
      return inner ? receiverPath(inner, owner, st) : UNTYPED_RECEIVER;
    }
    case 'field_access': {
      const object = child(node, 'object');
      const field = child(node, 'field_name');
      if (!object || !field) return UNTYPED_RECEIVER;
      const head = receiverPath(object, owner, st);
      if (head === UNTYPED_RECEIVER) return head;
      const name = getNodeText(field, st.ctx.source).trim();
      return head ? `${head}.${name}` : name;
    }
    default:
      return UNTYPED_RECEIVER;
  }
}

/** The receiver of a `method_invocation`; undefined for a call on the caller's own object. */
function receiverOf(call: SyntaxNode, owner: Node | null, st: FileState): string | undefined {
  if (child(call, 'super_keyword')) return superOf(owner, st) ?? UNTYPED_RECEIVER;
  const target = child(call, 'method_object')?.namedChildren[0];
  if (!target) return undefined;
  return receiverPath(target, owner, st) || undefined;
}

function handleInvocation(call: SyntaxNode, fn: Node, owner: Node | null, st: FileState): void {
  const { source } = st.ctx;
  const nameNode = child(call, 'method_name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, source);
  const lower = name.toLowerCase();
  const receiver = receiverOf(call, owner, st);
  // The parentheses are named nodes in this grammar; only the arguments count.
  const args = (child(call, 'argument_list')?.namedChildren ?? []).filter((a) => a.type === 'r_value_expression');

  if (FIRE_EVENT_FUNCTIONS.has(lower)) {
    const event = stringContent(args[0] ?? null, source);
    if (event && TYPE_NAME_RE.test(event)) {
      addRef(st, fn.id, receiver ? `${receiver}.${event}` : event, 'calls', call);
    }
    return;
  }
  if (OPEN_FUNCTIONS.has(lower) && !child(call, 'method_object')) {
    for (const arg of args) {
      const literal = stringContent(arg, source);
      const target = literal ?? (arg.type === 'r_value_expression' ? getNodeText(arg, source).trim() : null);
      if (target && TYPE_NAME_RE.test(target)) addRef(st, fn.id, target, 'instantiates', arg);
    }
    return;
  }
  addRef(st, fn.id, receiver ? `${receiver}.${name}` : name, 'calls', call);
}

/** `call super::open` / `call u_dw::constructor` / `call w_main`cb_ok::clicked`. */
function handleCallStatement(stmt: SyntaxNode, fn: Node, owner: Node | null, st: FileState): void {
  const { source } = st.ctx;
  const ancestorNode = child(stmt, 'ancestor_name');
  const eventNode = child(stmt, 'event_name');
  if (!ancestorNode || !eventNode) return;
  const event = getNodeText(eventNode, source);
  const control = child(stmt, 'control_name');
  let ancestor = getNodeText(ancestorNode, source);
  if (ancestor.toLowerCase() === 'super') ancestor = superOf(owner, st) ?? '';
  // `call w_base\`cb_ok::clicked` — the `cb_ok` inside `w_base`.
  if (control && ancestor) ancestor = `${ancestor}\`${getNodeText(control, source)}`;
  addRef(st, fn.id, ancestor ? `${ancestor}.${event}` : event, 'calls', stmt);
}

function handleCreate(stmt: SyntaxNode, fn: Node, st: FileState): void {
  const { source } = st.ctx;
  const type = child(stmt, 'type');
  if (type) {
    addRef(st, fn.id, getNodeText(type, source), 'instantiates', type);
    return;
  }
  const dynamic = child(stmt, 'dynamic_type');
  const name = stringContent(dynamic ? child(dynamic, 'string_literal') : null, source);
  if (dynamic && name && TYPE_NAME_RE.test(name)) addRef(st, fn.id, name, 'instantiates', dynamic);
}

/** The declared non-primitive types of a script's arguments and locals. */
function collectLocals(header: SyntaxNode | null, block: SyntaxNode | null, st: FileState): void {
  const { source } = st.ctx;
  st.locals = new Map();
  for (const param of header?.descendantsOfType('parameter') ?? []) {
    const name = child(param, 'parameter_name');
    const custom = descendant(child(param, 'type'), 'custom_type');
    if (name && custom) st.locals.set(getNodeText(name, source).toLowerCase(), getNodeText(custom, source));
  }
  for (const decl of block?.descendantsOfType('local_variable_declaration') ?? []) {
    const custom = descendant(child(decl, 'variable_type'), 'custom_type');
    if (!custom) continue;
    const type = getNodeText(custom, source);
    for (const v of child(decl, 'variable_declaration_list')?.namedChildren ?? []) {
      const name = child(v, 'variable_name');
      if (name) st.locals.set(getNodeText(name, source).toLowerCase(), type);
    }
  }
}

function walkBody(node: SyntaxNode, fn: Node, owner: Node | null, st: FileState): void {
  for (const c of node.namedChildren) {
    switch (c.type) {
      case 'method_invocation':
        handleInvocation(c, fn, owner, st);
        break;
      case 'call_statement':
        handleCallStatement(c, fn, owner, st);
        break;
      case 'create_statement':
        handleCreate(c, fn, st);
        break;
      case 'local_variable_declaration': {
        const type = child(c, 'variable_type');
        if (type) typeRef(st, fn.id, type);
        break;
      }
    }
    walkBody(c, fn, owner, st);
  }
}

// --- File ------------------------------------------------------------------

/**
 * The file's sections in order. A section the grammar could not place ends up
 * under an ERROR node; its siblings are still walked so one bad statement does
 * not cost the rest of the file.
 */
function sections(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const c of root.namedChildren) {
    if (c.type === 'class_file' || c.type === 'ERROR') out.push(...sections(c));
    else out.push(c);
  }
  return out;
}

function extractFile(root: SyntaxNode, ctx: ExtractorContext): void {
  const st: FileState = {
    ctx,
    main: null,
    mainIsGlobal: false,
    current: null,
    classes: new Map(),
    ancestors: new Map(),
    containers: new Map(),
    declaredEvents: new Map(),
    functionFile: false,
    locals: new Map(),
  };
  for (const section of sections(root)) {
    switch (section.type) {
      case 'class_type_definition':
        handleClassType(section, st);
        break;
      case 'structure_definition':
        handleStructure(section, st);
        break;
      case 'instance_variables_section':
      case 'shared_variables_section':
      case 'global_variables_section':
        handleVariablesSection(section, st);
        break;
      case 'external_function_prototypes':
        handleExternalPrototypes(section, st);
        break;
      case 'function_definition':
        handleFunction(section, st);
        break;
      case 'event_definition':
        handleEvent(section, st);
        break;
      case 'on_event_definition':
        handleOnEvent(section, st);
        break;
      // `forward` / `forward prototypes` repeat what the file defines below;
      // `global w_main w_main` is the object's own global instance.
      default:
        break;
    }
  }
  // A user event declared on a type but given no script here is still a
  // member descendants override and callers fire (`dw.event pfc_retrieve()`).
  for (const { owner, decl } of st.declaredEvents.values()) {
    const nameNode = child(decl, 'event_name');
    if (!nameNode) continue;
    createIn(st, owner, 'method', getNodeText(nameNode, ctx.source), decl, {
      signature: collapse(getNodeText(decl, ctx.source)),
      decorators: ['event'],
    });
  }
}

export const powerbuilderExtractor: LanguageExtractor = {
  // A replacer function: in a replacement string `$$` would collapse to `$`.
  preParse: (source) => source.replace(SCOPED_EVENT_RE, (_m, head: string) => head + SCOPED_EVENT_MARK),
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: '',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    if (node.type !== 'source_file') return false;
    extractFile(node, ctx);
    return true;
  },
};
