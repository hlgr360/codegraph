/**
 * PowerBuilder (PowerScript) reference resolution.
 *
 * PowerScript names ignore case, and its objects overload freely (PFC's
 * `of_getitem` has three bodies in one file), so the name matcher's exact,
 * case-sensitive and unique-candidate strategies found almost none of a
 * project's calls. PowerScript's own lookup is simple, and is what this
 * follows, from what the extractor writes down (see
 * extraction/languages/powerbuilder.ts):
 *
 * 1. A type — `from w_response`, `create n_cst_x`, a variable's declared
 *    type — is the class or structure of that name, preferring the caller's
 *    own file (every window declares its own `cb_ok` control).
 * 2. A call with no receiver (`of_init()`, `this.of_init()`) is a function or
 *    event of the class whose script makes it, or of what that class inherits
 *    (`from …`, read off the class's signature), else a global function.
 * 3. `T.m` where T is a class (the extractor writes `T` for `super::`, an
 *    explicit ancestor, a control and a local of type T) is T's `m` or one it
 *    inherits. Where T is instead an instance variable of the caller's class
 *    chain, or a global variable (`gnv_app`), its declared type is used.
 * 4. A call through a receiver whose type none of that tells — a variable
 *    declared in an object outside the index — links only a method of the one
 *    class that declares that name.
 *
 * Overloads are told apart by how many arguments the call passes (read off
 * the call site), the nearest class's first; overloads taking the same number
 * of arguments are not, and the first one declared wins. Built-in functions (`IsValid`, `MessageBox`)
 * and system classes (`window`, `nonvisualobject`) are not in the index and
 * stay unresolved. Nothing here runs for another language.
 */
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { MaybeYield } from './cooperative-yield';
import { DATAOBJECT_REF } from '../extraction/languages/powerbuilder';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const LANG = 'powerbuilder';
const TYPE_KINDS = new Set(['class', 'struct']);
const VARIABLE_KINDS = new Set(['field', 'variable', 'constant']);
const MAX_ANCESTRY = 32;

/**
 * `global type w_x from w_response within w_frame` → `w_response`;
 * `type m_file from m_master\`m_file within m_frame` → `m_master\`m_file`.
 */
function ancestorName(cls: Node): string | undefined {
  return /\bfrom\s+((?:[\w$#%-]+`)?[\w$#%-]+)/i.exec(cls.signature ?? '')?.[1];
}

/** `type cb_ok from u_cb within w_main` → the `w_main` of the same file. */
function containerOf(cls: Node, context: ResolutionContext): Node | undefined {
  const within = /\bwithin\s+([\w$#%-]+)/i.exec(cls.signature ?? '')?.[1];
  if (!within) return undefined;
  const lower = within.toLowerCase();
  return pbNodes(within, context).find((n) => TYPE_KINDS.has(n.kind) && n.filePath === cls.filePath && n.name.toLowerCase() === lower);
}

/**
 * A name a script uses unqualified: the script's class and what it inherits,
 * then — as PowerScript looks outward from a control's script to its window,
 * or from a menu item's to its menu — the class it is declared `within`.
 */
function memberOutward(cls: Node, name: string, kinds: ReadonlySet<string>, context: ResolutionContext, arity?: Arity): Node | undefined {
  const seen = new Set<string>();
  for (let c: Node | undefined = cls; c && !seen.has(c.id); c = containerOf(c, context)) {
    seen.add(c.id);
    const member = memberInChain(c, name, kinds, context, arity);
    if (member) return member;
  }
  return undefined;
}

/** The class a member belongs to: the last `::` segment before its own name. */
function ownerName(member: Node): string | undefined {
  const parts = member.qualifiedName.split('::');
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

/** `n_cst_x inv_x` / `constant integer X = 0` → the declared type. */
function declaredType(variable: Node): string | undefined {
  const words = (variable.signature ?? '').replace(/^constant\s+/i, '').trim().split(/\s+/);
  return words.length >= 2 ? words[0] : undefined;
}

/**
 * Per-resolution-pass memos: every call walks its class chain, and a large
 * project resolves the same few hundred names and chains thousands of times.
 * Cleared with the resolver's caches (clearPowerBuilderMemos).
 */
const PB_NODES = new WeakMap<ResolutionContext, Map<string, Node[]>>();
const PB_ANCESTRIES = new WeakMap<ResolutionContext, Map<string, Node[]>>();
const PB_EXTENDED = new WeakMap<ResolutionContext, Set<string>>();

function memo<T>(store: WeakMap<ResolutionContext, Map<string, T>>, context: ResolutionContext, key: string, compute: () => T): T {
  let map = store.get(context);
  if (!map) store.set(context, (map = new Map()));
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = compute()));
  return value;
}

export function clearPowerBuilderMemos(context: ResolutionContext): void {
  PB_NODES.delete(context);
  PB_ANCESTRIES.delete(context);
  PB_EXTENDED.delete(context);
}

function pbNodes(name: string, context: ResolutionContext): Node[] {
  const lower = name.toLowerCase();
  return memo(PB_NODES, context, lower, () => context.getNodesByLowerName(lower).filter((n) => n.language === LANG));
}

/**
 * The project type named `name`, nearest the caller first. `outer\`inner` is
 * the control or menu item `inner` declared inside the type `outer`.
 */
function findType(name: string, fromFile: string, context: ResolutionContext): Node | undefined {
  const tick = name.indexOf('`');
  if (tick > 0) {
    const outer = findType(name.slice(0, tick), fromFile, context);
    const inner = name.slice(tick + 1).toLowerCase();
    return outer
      ? pbNodes(inner, context).find((n) => TYPE_KINDS.has(n.kind) && n.filePath === outer.filePath && n.name.toLowerCase() === inner)
      : undefined;
  }
  const types = pbNodes(name, context).filter((n) => TYPE_KINDS.has(n.kind));
  return types.find((n) => n.filePath === fromFile) ?? types.find((n) => n.isExported) ?? types[0];
}

/**
 * The DataWindow named `name` — the `.srd` object a `dataobject = "d_x"`, a
 * nested report or a drop-down names — nearest the caller first. It is a
 * `component`, not a type: nothing inherits from it, and explore lets a query
 * name it exactly.
 */
function findDataWindow(name: string, fromFile: string, context: ResolutionContext): Node | undefined {
  const found = pbNodes(name, context).filter((n) => n.kind === 'component');
  return found.find((n) => n.filePath === fromFile) ?? found[0];
}

/** `constant string c_dw = "d_x"` / `string is_dw = 'd_x'` — the literal a variable is declared with. */
function initialLiteral(variable: Node): string | undefined {
  return /=\s*(["'])([A-Za-z_][\w$#%-]*)\1\s*$/.exec(variable.signature ?? '')?.[2];
}

/** Whether some project class is declared `from` this type (lowercased names, built once per pass). */
function isExtended(type: Node, context: ResolutionContext): boolean {
  let parents = PB_EXTENDED.get(context);
  if (!parents) {
    parents = new Set();
    for (const cls of context.getNodesByKind('class')) {
      const parent = cls.language === LANG ? ancestorName(cls)?.toLowerCase() : undefined;
      if (parent) parents.add(parent);
    }
    PB_EXTENDED.set(context, parents);
  }
  return parents.has(type.name.toLowerCase());
}

/**
 * The DataWindow a type sets for itself — `string dataobject = "d_x"` in its
 * type block, or in the nearest ancestor that has one (a datastore subclass
 * inherits it). Read from the source: the reference from the type to its
 * DataWindow may not be resolved yet.
 */
function dataObjectOf(type: Node, context: ResolutionContext): Node | undefined {
  for (const cls of ancestry(type, context)) {
    const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/);
    if (!lines) continue;
    const block = lines.slice(cls.startLine - 1, cls.endLine).join('\n');
    const name = /\bdataobject\s*=\s*(["'])([A-Za-z_][\w$#%-]*)\1/i.exec(block)?.[2];
    const found = name ? findDataWindow(name, cls.filePath, context) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * A DataWindow named by something other than a literal (see
 * handleDataObjectAssignment): `c_dw` or `gnv_const.c_dw_orders` read the
 * literal the constant is declared with; `ds_in.dataobject` the DataWindow the
 * receiver's type sets. Heuristic — the value could be changed at run time —
 * so it carries a lower confidence than a literal.
 */
function resolveDataObjectValue(ref: UnresolvedRef, path: string, context: ResolutionContext): ResolvedRef | null {
  const links = path.split('.');
  const last = links.pop()!;
  const from = callerClass(ref, context);
  let target: Node | undefined;
  if (links.length === 0) {
    const variable = (from ? memberOutward(from, last, VARIABLE_KINDS, context) : undefined) ??
      pbNodes(last, context).find((n) => VARIABLE_KINDS.has(n.kind) && initialLiteral(n));
    const literal = variable ? initialLiteral(variable) : undefined;
    target = literal ? findDataWindow(literal, ref.filePath, context) : undefined;
  } else {
    const type = receiverType(links, from, ref, context);
    if (!type) return null;
    // What a type declares is the receiver's DataWindow only when the type is
    // concrete: a control written in this file, or a class nothing extends. A
    // base reused by many (`u_dw_map`, default `d_map_dummy`) says nothing
    // about the subclass or the value assigned at run time.
    if (last.toLowerCase() === 'dataobject') target = type.filePath === ref.filePath || !isExtended(type, context) ? dataObjectOf(type, context) : undefined;
    else {
      const member = memberInChain(type, last, VARIABLE_KINDS, context);
      const literal = member ? initialLiteral(member) : undefined;
      target = literal ? findDataWindow(literal, member!.filePath, context) : undefined;
    }
  }
  return target ? resolved(ref, target, 0.7) : null;
}

/**
 * The class `cls` is declared `from`. A control or menu item named after its
 * ancestor (`type u_button from u_button within w_x`) does not inherit from
 * itself: the ancestor is the other type of that name.
 */
function parentOf(cls: Node, context: ResolutionContext): Node | undefined {
  const parent = ancestorName(cls);
  if (!parent) return undefined;
  const found = findType(parent, cls.filePath, context);
  if (found?.id !== cls.id) return found;
  const others = pbNodes(parent, context).filter((n) => TYPE_KINDS.has(n.kind) && n.id !== cls.id);
  return others.find((n) => n.isExported) ?? others[0];
}

/** `cls` and what it inherits, nearest first. */
function ancestry(cls: Node, context: ResolutionContext): Node[] {
  return memo(PB_ANCESTRIES, context, cls.id, () => computeAncestry(cls, context));
}

function computeAncestry(cls: Node, context: ResolutionContext): Node[] {
  const chain: Node[] = [cls];
  const seen = new Set([cls.id]);
  let current = cls;
  while (chain.length < MAX_ANCESTRY) {
    const next = parentOf(current, context);
    if (!next || seen.has(next.id)) break;
    chain.push(next);
    seen.add(next.id);
    current = next;
  }
  return chain;
}

/** The members of `cls` itself named `name`, in source order (overloads share a name). */
function ownMembers(cls: Node, name: string, kinds: ReadonlySet<string>, context: ResolutionContext): Node[] {
  const lower = cls.name.toLowerCase();
  return pbNodes(name, context)
    .filter((n) => n.filePath === cls.filePath && kinds.has(n.kind) && ownerName(n)?.toLowerCase() === lower)
    .sort((a, b) => a.startLine - b.startLine);
}

const CALLABLE_KINDS = new Set(['method', 'function']);

/** How many arguments a call passes, read lazily — only overloads need it. */
type Arity = () => number | undefined;

/**
 * The overload a call means: the nearest one (own class before ancestors)
 * declaring as many parameters as the call passes, else the nearest one.
 */
function pickOverload(candidates: Node[], arity?: Arity): Node | undefined {
  if (candidates.length <= 1 || !arity) return candidates[0];
  const passed = arity();
  return (passed === undefined ? undefined : candidates.find((n) => parameterCount(n) === passed)) ?? candidates[0];
}

function memberInChain(cls: Node, name: string, kinds: ReadonlySet<string>, context: ResolutionContext, arity?: Arity): Node | undefined {
  const candidates: Node[] = [];
  for (const c of ancestry(cls, context)) {
    candidates.push(...ownMembers(c, name, kinds, context));
    if (candidates.length > 0 && !arity) break;
  }
  return pickOverload(candidates, arity);
}

/** The arguments between the parentheses that open at `text[open]`, or undefined if they never close. */
function countArguments(text: string, open: number): number | undefined {
  let depth = 0;
  let commas = 0;
  let quote = '';
  let any = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '~') i++; // PowerScript's escape character
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; if (depth > 1) any = true; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return any ? commas + 1 : 0;
      continue;
    }
    if (depth === 1 && ch === ',') commas++;
    else if (depth >= 1 && !/[\s&]/.test(ch)) any = true; // `&` continues a line
  }
  return undefined;
}

/** Parameters a function, event or external declares, from its signature. */
function parameterCount(node: Node): number | undefined {
  const sig = node.signature ?? '';
  const open = sig.indexOf('(');
  return open >= 0 ? countArguments(sig, open) : undefined;
}

/** Arguments the call at `ref` passes to `method`, read from the source. */
function callArity(ref: UnresolvedRef, method: string, context: ResolutionContext): number | undefined {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!lines) return undefined;
  const text = lines.slice(ref.line - 1, ref.line + 19).join('\n');
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^\\w$#%-])${escaped}\\s*\\(`, 'gi');
  // The ref's column counts bytes, which run ahead of characters on a line
  // with non-ASCII text before the call: take the last match starting at or
  // before it, else the first.
  let chosen: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!chosen || m.index <= ref.column) chosen = m;
    if (m.index > ref.column) break;
  }
  if (!chosen) return undefined;
  return countArguments(text, chosen.index + chosen[0].length - 1);
}

/** The class whose script holds `fromNodeId`. */
function callerClass(ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller) return undefined;
  if (TYPE_KINDS.has(caller.kind)) return caller;
  const owner = ownerName(caller);
  if (!owner) return undefined;
  const lower = owner.toLowerCase();
  return pbNodes(owner, context).find((n) => TYPE_KINDS.has(n.kind) && n.filePath === caller.filePath && n.name.toLowerCase() === lower);
}

/** The type of a receiver that is a variable: an instance variable of the chain, else a global. */
function variableType(receiver: string, from: Node | undefined, ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  const variable = (from ? memberOutward(from, receiver, VARIABLE_KINDS, context) : undefined) ??
    pbNodes(receiver, context).find((n) => n.kind === 'variable' && n.isExported);
  const type = variable ? declaredType(variable) : undefined;
  return type ? findType(type, variable!.filePath, context) ?? findType(type, ref.filePath, context) : undefined;
}

function receiverType(links: string[], from: Node | undefined, ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  const [first, ...rest] = links;
  if (!first || first === '?') return undefined;
  let type = variableType(first, from, ref, context) ?? findType(first, ref.filePath, context);
  for (const link of rest) {
    if (!type) return undefined;
    const field = memberInChain(type, link, VARIABLE_KINDS, context);
    const declared = field ? declaredType(field) : undefined;
    type = declared ? findType(declared, field!.filePath, context) : undefined;
  }
  return type;
}

function resolved(ref: UnresolvedRef, target: Node, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId: target.id, confidence, resolvedBy: 'qualified-name' };
}

function resolveCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  const dot = name.lastIndexOf('.');
  const receiver = dot > 0 ? name.slice(0, dot) : '';
  const method = dot > 0 ? name.slice(dot + 1) : name;
  const from = callerClass(ref, context);
  let passed: { n: number | undefined } | undefined;
  const arity: Arity = () => (passed ??= { n: callArity(ref, method, context) }).n;

  if (!receiver) {
    const member = from ? memberOutward(from, method, CALLABLE_KINDS, context, arity) : undefined;
    if (member) return resolved(ref, member, 0.9);
    const globals = pbNodes(method, context).filter((n) => n.kind === 'function')
      .sort((a, b) => Number(b.filePath === ref.filePath) - Number(a.filePath === ref.filePath) || a.startLine - b.startLine);
    const global = pickOverload(globals, arity);
    return global ? resolved(ref, global, 0.8) : null;
  }

  // A receiver path (`inv_svc`, `lv_1.inv_datasource`) is typed link by link:
  // the first is a variable seen from the caller or a type, each later one an
  // instance variable of the type before it. `?` is a receiver the extractor
  // could not type (a call's result).
  const type = receiverType(receiver.split('.'), from, ref, context);
  if (type) {
    const member = memberInChain(type, method, CALLABLE_KINDS, context, arity);
    if (member) return resolved(ref, member, 0.9);
    // A project type's chain that ends in a system class (`u_dw` from
    // `datawindow`) — the method is that system class's built-in.
    return null;
  }

  const candidates = pbNodes(method, context).filter((n) => n.kind === 'method');
  const owners = new Set(candidates.map((n) => `${n.filePath}\0${ownerName(n)?.toLowerCase()}`));
  if (owners.size !== 1) return null;
  const overload = pickOverload([...candidates].sort((a, b) => a.startLine - b.startLine), arity);
  return overload ? resolved(ref, overload, 0.6) : null;
}

/** Resolve a PowerScript reference; null when the project defines no target. */
export function matchPowerBuilderRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== LANG) return null;
  switch (ref.referenceKind) {
    case 'calls':
      return resolveCall(ref, context);
    case 'extends':
    case 'instantiates':
    case 'references': {
      if (ref.referenceKind === 'references' && ref.referenceName.startsWith(DATAOBJECT_REF)) {
        return resolveDataObjectValue(ref, ref.referenceName.slice(DATAOBJECT_REF.length), context);
      }
      // A class is never its own ancestor (see parentOf).
      const from = ref.referenceKind === 'extends' ? context.getNodeById?.(ref.fromNodeId) : undefined;
      const type = (from && TYPE_KINDS.has(from.kind) ? parentOf(from, context) : undefined) ??
        findType(ref.referenceName, ref.filePath, context) ??
        (ref.referenceKind === 'references' ? findDataWindow(ref.referenceName, ref.filePath, context) : undefined);
      return type && type.id !== ref.fromNodeId ? resolved(ref, type, 0.9) : null;
    }
    default:
      return null;
  }
}

// --- A DataWindow handed to a dialog through a structure --------------------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The class whose script holds `node`: the node itself when it is one. */
function owningClassOf(node: Node, context: ResolutionContext): Node | undefined {
  if (TYPE_KINDS.has(node.kind)) return node;
  const owner = ownerName(node);
  if (!owner) return undefined;
  const lower = owner.toLowerCase();
  return pbNodes(owner, context).find((n) => TYPE_KINDS.has(n.kind) && n.filePath === node.filePath && n.name.toLowerCase() === lower);
}

/** The project type `name` is declared with in `text` (`u_ds_orders ds_a`), when it is one of `kinds`. */
function declaredProjectType(name: string, text: string, kinds: ReadonlySet<string>, context: ResolutionContext): Node | undefined {
  const re = new RegExp(`(?:^|[\\s,(;])([A-Za-z_][\\w$#%-]*)\\s+${escapeRegExp(name)}\\b(?!\\s*[(.])`, 'gi');
  for (const m of text.matchAll(re)) {
    const found = pbNodes(m[1]!, context).find((n) => kinds.has(n.kind));
    if (found) return found;
  }
  return undefined;
}

/**
 * A DataWindow a dialog shows through a structure its opener fills in.
 *
 * `dw_1.dataobject = lstr.modify_ds.dataobject` in a dialog types `lstr` as a
 * structure whose `modify_ds` is declared as the system `datastore`: the
 * DataWindow is whatever the opener put there. The resolver leaves that
 * reference open (`dataobject:` + the typed path). Here it is completed from
 * the code that opens the dialog, and only from there:
 *
 *   - the function that opens the window — `OpenWithParm(w_dialog, lstr_parm)`
 *     — passing a variable declared as that structure,
 *   - the assignment, in the same function, of an object to that field
 *     (`lstr_parm.modify_ds = ds_a`),
 *   - the DataWindow that object's type sets (the type it is `create`d as, or
 *     else the one it is declared with when nothing extends it).
 *
 * Several openers each contribute their own DataWindow: the dialog can show any
 * of them. An assignment somewhere else in the project, or one that feeds a
 * different window, is never counted — the structure is a carrier, and the
 * window it is passed to says which flow is meant.
 */
export async function pbDataObjectFlowEdges(queries: QueryBuilder, context: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const edges = new Map<string, Edge>();
  let scanned = 0;
  for (const ref of queries.getUnresolvedByNamePrefix(DATAOBJECT_REF)) {
    if ((++scanned & 63) === 0) await onYield();
    if (ref.language !== LANG || ref.referenceKind !== 'references') continue;
    const links = ref.referenceName.slice(DATAOBJECT_REF.length).split('.');
    if (links.length !== 3 || links[2]!.toLowerCase() !== 'dataobject') continue;
    const [structName, field] = links as [string, string, string];
    const struct = pbNodes(structName, context).find((n) => n.kind === 'struct');
    const consumer = queries.getNodeById(ref.fromNodeId);
    const owner = consumer ? owningClassOf(consumer, context) : undefined;
    if (!struct || !consumer || !owner) continue;

    // The dialog is the nearest class around the script that something opens.
    for (let dialog: Node | undefined = owner; dialog; dialog = containerOf(dialog, context)) {
      const openers = queries.getIncomingEdges(dialog.id, ['instantiates']);
      if (openers.length === 0) continue;
      for (const open of openers) {
        const opener = queries.getNodeById(open.source);
        const lines = opener ? context.getFileLines?.(opener.filePath) ?? context.readFile(opener.filePath)?.split(/\r?\n/) : undefined;
        if (!opener || !lines) continue;
        const text = lines.slice(opener.startLine - 1, opener.endLine).join('\n');
        const passed = new RegExp(`\\bOpen\\w*WithParm\\s*\\(\\s*${escapeRegExp(dialog.name)}\\s*,\\s*([A-Za-z_][\\w$#%-]*)`, 'gi');
        for (const parm of text.matchAll(passed)) {
          if (declaredProjectType(parm[1]!, text, new Set(['struct']), context)?.id !== struct.id) continue;
          const assigned = new RegExp(`(?:^|[^\\w$#%.-])${escapeRegExp(parm[1]!)}\\s*\\.\\s*${escapeRegExp(field)}\\s*=\\s*([A-Za-z_][\\w$#%-]*)\\s*(?:\\r?\\n|$|//)`, 'gim');
          for (const value of text.matchAll(assigned)) {
            const object = value[1]!;
            const created = new RegExp(`(?:^|[^\\w$#%.-])${escapeRegExp(object)}\\s*=\\s*create\\s+(?:using\\s+)?([A-Za-z_][\\w$#%-]*)`, 'i').exec(text)?.[1];
            const exact = created ? pbNodes(created, context).find((n) => TYPE_KINDS.has(n.kind)) : undefined;
            const declared = exact ?? declaredProjectType(object, text, TYPE_KINDS, context);
            // A created type is what the object is; a declared one may be a base a subclass stands in for.
            const type = exact ?? (declared && !isExtended(declared, context) ? declared : undefined);
            const target = type ? dataObjectOf(type, context) : undefined;
            if (!target) continue;
            const key = `${consumer.id}\0${target.id}`;
            if (edges.has(key)) continue;
            edges.set(key, {
              source: consumer.id,
              target: target.id,
              kind: 'references',
              line: ref.line,
              column: ref.column,
              provenance: 'heuristic',
              metadata: {
                synthesizedBy: 'pb-dataobject-flow',
                registeredAt: `${opener.filePath}:${open.line ?? opener.startLine}`,
                via: `${struct.name}.${field}`,
                opener: opener.name,
              },
            });
          }
        }
      }
      break;
    }
  }
  return [...edges.values()];
}
