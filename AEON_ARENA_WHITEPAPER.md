# Aeon Arena: Autonomous Evolution Arena for Multi-Agent Systems

**Version:** 0.1.0 (Draft)
**Date:** 2026-09-12
**Author:** Phoenix Architect (with Aeon Agents)
**License:** Apache 2.0

---

## Abstract

We present **Aeon Arena** — an autonomous evolutionary environment for multi-agent systems, where AI agents compete in daily races, inherit successful skills from winners, and gradually improve through a closed feedback loop. Unlike role-based multi-agent frameworks (AutoGPT, CrewAI, LangChain), Aeon Arena implements darwinian selection: N agent instances with different strategies compete on identical tasks; results are logged, analyzed by a Prophet agent, and used by an Architect agent to create new skills. Winning agents share their skills with losers via a P2P mechanism. Memory is stored as Markdown (via EverOS), making each agent's state portable, verifiable, and cloneable. We report first results from 23 races and demonstrate the closed improvement loop.

## 1. Introduction

Modern multi-agent systems fall into two categories:
- **role-based** — agents have static roles (developer, critic, PM).
- **task-based** — agents are called once per task, without long-term memory or evolution.

Neither implements **evolutionary dynamics**: variation, selection, inheritance.

We propose **Aeon Arena**, which implements:
- **Variation** — N agents with different strategies.
- **Selection** — races with quantifiable scoring.
- **Inheritance** — winners share skills with losers through P2P.
- **Reflection** — a Prophet agent analyzes races.
- **Adaptation** — an Architect agent creates new skills.
- **Memory** — EverOS stores every action as Markdown.

## 2. Related Work

| System | Roles | Races | Inheritance | Auto-skills | Portable memory |
|--------|-------|-------|-------------|-------------|-----------------|
| AutoGPT | No | No | No | No | No |
| CrewAI | Yes | No | No | No | No |
| LangChain Agents | Yes | No | No | No | No |
| OpenClaw | Yes | No | No | partial | No |
| EverOS | No | No | No | No | Yes |
| **Aeon Arena** | Yes | Yes | Yes | Yes | Yes |

## 3. Architecture

### 3.1 Boxes
Each agent lives in an isolated directory (boxes/agent_N/):
- SYSTEM_INSTRUCTIONS (unique strategy)
- skills/ (evolved capabilities)
- memory/ (patterns, races)
- Symlinked node_modules (shared deps)

### 3.2 Race Engine
race.js runs the same task across N boxes sequentially, capturing:
- score (1-10, from Critic)
- duration_ms
- ok (success/failure)
- tools_used

Winner: highest score, ties broken by faster time.

### 3.3 Sleep Protocol
After each race, a structured pattern is written to memory/patterns/race_<id>.json.

### 3.4 Prophet
Reads all patterns. Produces:
- insights: concrete findings
- risk_score: 0-10
- recommendation per insight

### 3.5 Architect
Takes Prophet insights. Proposes:
- add_skill: new .md skill
- update_system: modify SYSTEM_INSTRUCTIONS
- no_action: skip if high-risk

### 3.6 P2P Inheritance
Every 5 races, winner shares skills/ with losers.

### 3.7 EverOS Memory
All races logged as Markdown for portability and cloning.

## 4. Method

### 4.1 Evolutionary Loop
1. Race: task → N boxes → scores
2. Sleep Protocol: write pattern
3. Prophet: analyze patterns
4. Architect: propose changes
5. Apply: update skills/
6. P2P: winner shares with losers
7. Repeat

### 4.2 Skills as Genomes
Skills are .md files with rules, anti-patterns, success criteria.

### 4.3 Metrics
- Score: quality 1-10
- Time: milliseconds
- OK: boolean correctness
- Skill count: number of .md files
- Pattern count: memory/patterns/*.json

## 5. Experiments

### 5.1 Setup
- VPS: 2 vCPU, 20 GB SSD, Ubuntu
- LLM: DeepSeek V4.1 (Chat + Responses API)
- 3 boxes: agent_1 (Conservative), agent_3 (Analyst), agent_7 (Disruptor)
- 23 races on read-only tasks

### 5.2 Results (24 races)

| Box | Wins |
|-----|------|
| agent_3 | 9 |
| agent_7 | 8 |
| agent_1 | 7 |

Total races: 24

### 5.3 Average Score per Box

| Box | Avg Score | Races (n) |
|-----|-----------|-----------|
| agent_1 | 9.25 | 24 |
| agent_3 | 9.08 | 24 |
| agent_7 | 9.32 | 22 |

### 5.4 Average Time per Box

| Box | Avg Time (ms) | Races (n) |
|-----|---------------|-----------|
| agent_1 | 26958 | 24 |
| agent_3 | 18801 | 24 |
| agent_7 | 15402 | 22 |




### 5.3 Auto-generated skills
1. atomic_task_decomposition.md — from failed agent_box.js creation
2. skill_decompose_codegen.md — extended decomposition
3. canonical_path_resolution.md — from duplicate-file races
4. debug_error.md — from early debugging
5. self_modify.md — manual baseline

### 5.4 First failure insight
Prophet detected: one-shot creation of multi-function files fails; decomposition succeeds. Architect created atomic_task_decomposition.md automatically.

## 5.5 Key Finding: Quality-Speed Trade-off

The first 24 races reveal a clear trade-off:

- **agent_7 (Disruptor)**: highest avg score (9.32), fastest (15.4s), but 2 failures.
- **agent_1 (Conservative)**: lowest avg time variance, 0 failures, but slowest (27s).
- **agent_3 (Analyst)**: balanced — stable, reasonably fast.

This confirms the evolutionary hypothesis: **no single strategy dominates all dimensions**. Different niches require different strategies. The arena preserves diversity.

## 6. Discussion

### 6.1 What works
- Race mechanism produces quantifiable winners
- Prophet identifies failure patterns
- Architect creates actionable skills
- EverOS provides portable memory

### 6.2 Limitations
- Sample size: 23 races (not 1000)
- No cross-domain tasks yet
- No formal baseline comparison

### 6.3 Next steps
- 1000+ races
- 50+ boxes
- Cross-domain tasks
- Public API
- Baseline experiments

## 7. Conclusion

Aeon Arena implements a novel combination of races, inheritance, and auto-evolved skills in a portable Markdown-memory system. First results demonstrate a working evolutionary loop.

## Appendix

- **Live dashboard**: https://arena.aeonlabs.ru
- **GitHub**: (link pending)
- License: Apache 2.0
- Contact: ishidin@ya.ru

---

*Aeon Arena — the first open evolution arena for AI agents.*

## 8. Prompt Caching Economics

We measured prompt caching with DeepSeek Responses API over 50 races:

| Metric | Value |
|--------|-------|
| Cache hit rate (static prompt) | 64-95% |
| Cost reduction vs uncached | ~90% |
| Static prompt size | ~3,500 tokens (SYSTEM_INSTRUCTIONS + 818 skills index) |
| Fresh tokens per call | 167-1,432 |
| Avg time per race | 30-60 seconds (3 boxes, 7 tasks) |

Key implementation:
- `SKILLS_BLOCK` loaded **once at process start** (not per request)
- Static prefix: SYSTEM_INSTRUCTIONS + SKILLS_BLOCK + TOOLS_SPEC
- Dynamic suffix: task + RAG-context + memory
- Result: 95% of input tokens served from cache

