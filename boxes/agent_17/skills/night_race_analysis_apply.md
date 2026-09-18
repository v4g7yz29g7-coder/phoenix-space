# Applying night_race_analysis Safely

This skill outlines a step-by-step, read-only-first approach to applying the `night_race_analysis` skill, based on observed successful patterns.

## Steps

1. **Inventory relevant files**: Search for `SKILL.md`, `ROADMAP.md`, and any configuration files related to `night_race_analysis`. List them without modifying anything.
2. **Read the skill definition**: Open and read `SKILL.md` for `night_race_analysis`. Note its inputs, dependencies, and expected outputs.
3. **Identify dependencies**: Check for required scripts, modules, or data files. Do not copy or modify them yet.
4. **Log tools used**: Explicitly record which tools (e.g., `read_file`, `search_code`, `exec`) are used at each step.
5. **Perform minimal analysis**: Run only read-only analyses (e.g., counting, listing) as a first pass. Do not create or edit files.
6. **Verify results**: After each step, check output for correctness. If an error occurs, stop and report.
7. **Proceed incrementally**: Only after read-only steps succeed, consider making minimal changes, one at a time, with backups and syntax checks.

## Notes

- Avoid monolithic tasks that combine creation, copying, and manifest generation in one prompt.
- If a step fails, revert to the last successful read-only state and diagnose.
- Always keep the original files unmodified until the analysis phase is validated.