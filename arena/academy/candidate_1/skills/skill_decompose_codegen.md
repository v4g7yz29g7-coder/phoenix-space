# Skill: decompose_codegen

## Purpose
Safely generate large code files (like agent_box.js) by decomposing the task into verifiable steps instead of one-shot generation.

## When to use
- Target file will contain 3+ functions, classes, or module dependencies.
- The file imports/copies 5+ modules from elsewhere in the repo.
- Prior one-shot attempts on this task returned ok:false or empty output.

## Workflow

### Step 0 — Read-only inventory (mandatory)
Before writing any code:
- `search_code` / `grep` for the target filename and analogous existing files.
- `exec` to list the target directory and confirm the file does not already exist.
- Read 1–2 similar modules to copy their structure, import style, and export style.
- Record findings before proceeding. If the inventory fails, stop and report; do not generate blind.

### Step 1 — Skeleton only
Generate only:
- File header / docstring
- `require` / `import` statements (verify each path exists)
- Exported symbol names as stubs (`function foo() { /* TODO */ }`)
Do NOT fill in bodies yet.

### Step 2 — One function per step
For each function listed in Step 1:
- Implement exactly one function.
- Keep the surrounding file unchanged.
- Prefer `search_code` analog over invention.

### Step 3 — Verify after every step
After each write:
- Run a syntax check (`node --check <file>` or equivalent).
- Confirm referenced imports resolve.
- If verification fails, revert the step and re-plan before continuing.

### Step 4 — Parallel variants (optional)
When a sub-task is non-trivial, generate 2–3 candidate implementations in parallel (race pattern) and select the winner by score, then time.

### Step 5 — Explicit tools_used logging
After every step, emit a `tools_used` entry naming the exact tool invoked (e.g. `exec`, `grep`, `search_code`). Declared tools that were not actually executed must not appear; missed steps must be visible as gaps.

## Anti-patterns
- One-shot generation of a 7+ function file with 10+ copied modules → known failure mode.
- Claiming tool use in prose while leaving `tools_used` empty.
- Skipping syntax verification between steps.

## Success criteria
- Every step ends with a passing syntax/import check.
- `tools_used` accurately reflects executed steps.
- Final file matches the skeleton from Step 1.
