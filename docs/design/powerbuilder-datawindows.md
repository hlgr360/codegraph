# PowerBuilder DataWindows — what is indexed, what is left

**Last verified: 2026-10-11** against a real project (`pb project_110`: 17,783 files, 528,640 nodes,
7,417 DataWindows) on the `fork.5` + DataWindow build. A snapshot, not a live view: re-measure with the
queries at the end before trusting a number.

A DataWindow (`.srd`) is not PowerScript. Its export is a long layout plus one `table(...)` block with the
columns and the SQL, and PowerScript names it by a string (`dw.dataobject = "d_x"`). Batches and reports are
built from them, so a question about what a batch reads needs both the DataWindows and the links to them.

## What is indexed

| Thing | Node | Where it comes from |
|---|---|---|
| A DataWindow | `component`, decorated `datawindow`, exported | `datawindow-extractor.ts`; spans the `table(...)` block only |
| Its columns | `field`, signature `type ← database column` | one per `column=(...)` in the table block |
| Its SQL | the node's `docstring` | `retrieve="..."`, unescaped, CRLF folded |
| Tables read / updated, arguments | the node's `signature` | `tablesInSql`, `update=`, `arguments=` |
| A report's documentation | the docstring of the report's `.srf` function | `linkReportHeader`: `Report :`, `Datawindow :`, `Comment :` … |

A DataWindow is a `component`, not a `class`: explore only treats callable-like kinds as named seeds, so a
`class` named exactly in a query ranked 8th behind loosely matching files.

## What links to a DataWindow

| Link | Rule | Edge |
|---|---|---|
| `dw.dataobject = "d_x"` / `'d_x'`, a control's `string dataobject = "d_x"` | literal, from the narrowest symbol around it | resolved, 0.9 |
| nested report, `dddw.name=` | read from the `.srd` | resolved |
| `= ls_dw`, `= c_dw` | the file assigns that name a literal (an initial value counts) | resolved |
| `= gnv_const.c_dw`, `= ds_in.dataobject` | resolver: the constant's value, or the DataWindow the receiver's *concrete* type sets | resolved, 0.7 |
| a dialog reading `lstr.modify_ds.dataobject` | synthesizer pass: the function that `OpenWithParm`s the window, its assignments to that field | `pb-dataobject-flow` |
| a helper reading `check.in_dw.dataobject` | synthesizer pass: every control class that puts itself into the field, and its subclasses | `pb-dataobject-flow` |
| a report's `.srf` header, `Datawindow : d_x` (one per line) | `linkReportHeader`, nearest package wins a repeated name | resolved |

Guards that exist because the obvious rule was wrong:

- A type's `dataobject` counts only for a **concrete** type (a control in the same file, or a class nothing
  extends). A reusable base declares a placeholder (`u_dw_map` → `d_map_dummy`), which drew 22% of the
  copy-from-another-object links before the guard.
- A structure field filled by **more than 12 different classes** is a shared carrier: nothing is linked.
- A control family of **more than 40 DataWindows** is too diffuse to be an answer: nothing is linked.

## Numbers on the sample project

7,417 DataWindows, 198,844 columns, 84.8% with SQL, 1,401 distinct tables read.
**76.4% of DataWindows are linked from something**: `dialog` 87.3%, `batch` 87.1%, `reports` 44.2%.
278 `dataobject:` references stay unresolved (method arguments, system and generic base classes, values assigned elsewhere).

## Open items

### 1. The report catalog (needs input)

Reports are started by name from a catalog in the **database**: `u_nv_pbs_run_reports` does
`ds.DataObject = param.dw_name[1]` with the name read at run time. The source says which DataWindow a report is
only where a report script has a documentation header (about 280 of the 1,689 report DataWindows). The other
~940 have no static reference at all; `reports/` is 44.2% linked, and most of the rest is this.

What would close it: an **export of the catalog** (report code → DataWindow name, library, description) kept as
a file in the project, ingested by a small extractor, so `codegraph_explore` can answer "which DataWindow does
report code X run, and what does it read?".

To decide with the catalog's owner: the export format (CSV / JSON / SQL inserts), whether it includes customer
reports, how often it changes, and whether it may sit in the repository. Until then the report code is findable
only through the headers.

### 2. Table nodes

The design asked for a shared node per database table, so "which DataWindows read `prd_edition`?" is a
callers query. Not built: a node is stored by id and deleted with its file, so a table node shared by many
DataWindows cannot be owned by a per-file extractor (re-indexing one `.srd` would delete the others' table).
Today tables are named in each DataWindow's signature and its SQL is searchable. Real table nodes need a change
to how shared nodes are stored.

### 3. Smaller gaps

- A DataWindow named through a **method argument**, a **system** class, or a **generic base** (about 270
  references in the sample) is not linked: the code does not say which one it is.
- A structure passed down a call chain with no `OpenWithParm` and no control filling it is not followed.
- **Computed fields** (`compute(...)`) that call functions, and DataWindows with a **stored procedure**
  (none in the sample), are not read.
- **Library membership** (`.pbg`: which `.pbl` holds an object) is not indexed. It says where an object is
  packaged, not that it is used.
- A name built by **concatenation or a call** (`'d_x_' + Lower(...)`, `get_report_dw()`) is not followed.

## Re-verifying

The links are ordinary edges, so these hold against `.codegraph/codegraph.db`:

```sql
-- DataWindows, and how many are linked from something
SELECT count(*) FROM nodes WHERE kind='component' AND decorators LIKE '%datawindow%';
SELECT count(DISTINCT e.target) FROM edges e JOIN nodes t ON t.id=e.target
  WHERE e.kind='references' AND t.kind='component' AND t.decorators LIKE '%datawindow%';
-- the inferred struct-flow links
SELECT count(*) FROM edges WHERE metadata LIKE '%pb-dataobject-flow%';
-- references the resolver and the passes left open
SELECT count(*) FROM unresolved_refs WHERE reference_name LIKE 'dataobject:%';
```
