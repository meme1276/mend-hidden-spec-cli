# mend

One patch tool for every AI edit format.

Agent harnesses apply edits that models write, and models write them in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Each public applier reads one of them.

`mend` is a single command-line tool that reads all four formats to one written specification, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none (atomic apply).

Built as an entry for the make.fun bounty `hidden-spec-cli-01-run-20261122`.

## Usage

Run with Node 22:

```bash
node main.ts <patch-file> [options]
```

See `SPEC.md` for the full specification this tool implements.
