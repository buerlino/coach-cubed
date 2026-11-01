# Work packages

One file per package, `<id>.md`, run with `pipeline/pipeline.sh <id>`. The format, the ids and how a run goes:
[../pipeline.md](../pipeline.md#package-files). A merged package's file is deleted in a later docs commit (git keeps it);
an unmerged one stays until its branch merges or is given up.

## Template

````markdown
# w7: the result view's cue list (dirac, sonnet, branch `wp/dirac-cue-list`)
**Why:** what is missing or broken, with evidence (a file:line, a screen ID from docs/ui-design.md, a log line).
**Read:** docs/ui-design.md "R1"; src/diagnostics.js `computeResults()`; the files the steps change, by repo path.
**Red first:** yes
1. Tests first: what the new tests check, and that they fail on phase-0.
2. The change, step by step, naming the files.
3. What to measure or report, if anything.
**Done when:**
- each line checkable by reading the diff or running a command;
- the tests named in step 1 pass, and `npm test` and the Python tests pass.
````

Leave out `**Red first:** yes` for a package with no test that could fail first (a research note, a build script). A
research package goes to einstein, a phone measurement to curie.
