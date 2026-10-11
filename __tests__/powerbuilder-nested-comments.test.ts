/**
 * PowerScript block comments nest. The grammar's comment token ends at the
 * first closing delimiter, so a script wrapped in a `$ScriptEnvelope` comment
 * that holds a block comment of its own (release notes, a long SQL script) left
 * the rest of the outer comment as stray text: the file parsed with errors and
 * contributed no symbols. The extractor now flattens such comments before the
 * parse, without moving a single character.
 *
 * The stray text has to look like code to break the parse (the grammar recovers
 * from plain prose), so these scripts carry SQL, as the real ones do.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['powerbuilder']);
});

const crlf = (text: string): string => text.replace(/\n/g, '\r\n');
const callsOf = (code: string): string[] =>
  extractFromSource('main.pbl/n_orders.sru', code)
    .unresolvedReferences.filter((r) => r.referenceKind === 'calls')
    .map((r) => r.referenceName);

/** The shape of a real global-function export: an envelope around nested comments. */
const exportedReport = crlf(`HA$PBExportHeader$x_report.srf
global type x_report from function_object
end type

forward prototypes
global subroutine x_report ()
end prototypes

global subroutine x_report ();/*$ScriptEnvelope Start

/*
   Version     : 11.0.36
   Report      : XRUEBEABOA
*/
select * from xupdabop_history where status = 1
 /*
  update xupdabop_history set status = 0
 */
$ScriptEnvelope End*/
end subroutine
`);

/** A user object whose function holds a nested comment with SQL after the inner one. */
const userObject = (middle: string): string =>
  crlf(`global type n_orders from nonvisualobject
end type
global n_orders n_orders

public function integer of_load ();${middle}
of_reset()
return 1
end function

public subroutine of_reset ();
end subroutine
`);

describe('PowerBuilder nested block comments', () => {
  it('extracts a function whose body is an envelope around nested comments', () => {
    const result = extractFromSource('reports/x_report.srf', exportedReport);
    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.name === 'x_report')).toMatchObject({ kind: 'function', language: 'powerbuilder' });
  });

  it('keeps the code that follows a nested comment', () => {
    const nested = userObject(`/* outer
  /* inner */
  select * from t where a = 1
*/`);
    const result = extractFromSource('main.pbl/n_orders.sru', nested);
    expect(result.errors).toEqual([]);
    expect(result.nodes.filter((n) => n.kind === 'method').map((n) => n.name)).toEqual(
      expect.arrayContaining(['of_load', 'of_reset']),
    );
    expect(callsOf(nested)).toContain('of_reset');
    // Deeper nesting closes level by level: the comment ends at the last delimiter.
    expect(callsOf(userObject(`/* a /* b /* c */ select * from t */ d */`))).toContain('of_reset');
  });

  it('does not move a symbol: line numbers match the source', () => {
    const fn = extractFromSource('reports/x_report.srf', exportedReport).nodes.find((n) => n.name === 'x_report');
    const lines = exportedReport.split('\r\n');
    expect(fn?.startLine).toBe(lines.findIndex((l) => l.startsWith('global subroutine x_report ();')) + 1);
    expect(fn?.endLine).toBe(lines.findIndex((l) => l === 'end subroutine') + 1);
  });

  it('does not read an opening delimiter in a string or after // as a comment', () => {
    // Taking either for a comment would swallow the real comment after it, and
    // the select below would be left as code the grammar cannot read.
    const inString = userObject(`string ls_pattern
ls_pattern = "/* not a comment"
/* real comment
   select * from t where a = 1 */`);
    const afterLineComment = userObject(`// a line comment that mentions /* too
/* real comment
   select * from t where a = 1 */`);
    for (const code of [inString, afterLineComment]) {
      expect(extractFromSource('main.pbl/n_orders.sru', code).errors).toEqual([]);
      expect(callsOf(code)).toContain('of_reset');
    }
  });

  it('leaves a file with ordinary, un-nested comments as it was', () => {
    const code = userObject(`/* one comment */ integer li_x /* another */
li_x = 1 // trailing`);
    const result = extractFromSource('main.pbl/n_orders.sru', code);
    expect(result.errors).toEqual([]);
    expect(callsOf(code)).toContain('of_reset');
  });
});
