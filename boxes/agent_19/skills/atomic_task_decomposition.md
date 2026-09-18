# Skill: Atomic Task Decomposition & Read-Only First

## Purpose
Prevent failures on complex, multi-function file creation tasks and prioritize safe, evidence-based analysis.

## Trigger
Use this skill whenever a request involves:
- Creating or rewriting a file with multiple functions, modules, or dependencies (e.g. `agent_box.js`).
- Analysis tasks where a decision (e.g. "best strategy") must be justified by data.

## Rules

### 1. Read-Only First
Before any write, extract and validate the data needed:
1. List/count the relevant sources (races, pilots, strategies, files).
2. Present findings as a table.
3. Confirm the structure is correct.
4. Only then proceed to writing or conclusions.

Do NOT write files while gathering evidence. Respect explicit constraints such as "ничего не менять", "ничего не записывая", "остановиться" — these correlate with successful runs.

### 2. Atomic Decomposition
Never create a complex file in a single step. Split into ordered, independently verifiable steps:
1. Create an empty file (or add a stub with a clear header).
2. Add ONE function at a time.
3. Test/verify that function before adding the next.
4. Copy or resolve dependency references one at a time.
5. Run a final integration check.

Each step must have a verifiable success signal before moving on.

### 3. Evidence Before Claims
When asked to identify a "best strategy" or similar conclusion:
- First count/aggregate the raw entities (e.g. race count, pilot count, strategy occurrences) into a table.
- If no domain-specific proven patterns exist in `memory/patterns/`, state that explicitly and base conclusions ONLY on the newly gathered data — do not invent recommendations without evidence.

## Output Format
For analysis tasks, output:

| Metric | Value |
|--------|-------|
| ...    | ...   |

Then, separately, the interpretation — clearly marked as derived from the table above.

## Anti-Patterns
- Creating a multi-function file in one shot.
- Writing outputs before validation.
- Concluding "best strategy" without aggregated race data.
- Reusing unrelated patterns (ROADMAP.md, agent_manifest.json, etc.) as evidence for race analysis.
