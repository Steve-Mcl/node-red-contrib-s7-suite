# Tag Lists

Sample tag exports for the **Import CSV/Excel** button in the `s7-read` node (output mode "Object").

## Files

| File | Source / Format | Notes |
|---|---|---|
| `sample-tags.csv` | TIA Portal-style export, `;` separator | Matches the initial values of the built-in `sim` backend, so you can import it without a real PLC and see live values immediately |
| `tia-portal-tag-table-export.xlsx` / `.xml` / `.sdf` | Real exports of one S7-1200 default tag table (20 tags), from TIA Portal's tag table Export button, once per "Save as type" | The `.xml` is TIA's flat `<Tagtable>` format, not SimaticML; the `.sdf` is CSV without a header row. Used by the TIA XML parser tests |

## Expected columns

The importer auto-detects these column names (case-insensitive):

- **Name / Symbol / Tag** - becomes the label (and the object key in object mode)
- **Address** - PLC address in `nodes7-style` (`DB1,REAL0`) or `IEC-style` (`%DB1.DBD0`); the `%` prefix is stripped automatically

Separators auto-detected: tab, semicolon, comma.

## Adding new exports

When attaching a tag list to a bug report, prefix the file with the source, e.g. `tia-v17-bagger-station.xlsx`, `step7-v55-press-line.csv`. Keep file names ASCII-only.
