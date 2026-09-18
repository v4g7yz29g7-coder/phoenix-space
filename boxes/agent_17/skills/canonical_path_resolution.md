# Skill: Canonical Path Resolution

When a task involves locating a file (e.g., ROADMAP.md) that may exist in multiple locations:

1. **Search recursively** from the repository root.
2. **Identify all candidates** and record their full paths and file sizes.
3. **Determine canonical path**:
   - Prefer the root-level file (e.g., `/ROADMAP.md`) as the primary canonical path.
   - If a nested copy exists (e.g., `/public/ROADMAP.md`), explicitly mention it in the report with its size.
4. **Report findings**:
   - List all found paths with sizes.
   - State which is canonical and why.
   - If the task is read-only (search/lookup), do **not** modify any file; just output the report and stop.
5. **Avoid editing the wrong file**:
   - Never edit a file without first confirming the canonical path.
   - If unsure, ask for clarification.

This ensures safe and predictable behavior.