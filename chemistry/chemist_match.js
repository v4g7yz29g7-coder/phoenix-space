'use strict';

/**
 * chemistry/chemist_match.js
 * --------------------------
 * Chemist matching engine.
 *
 * The metaphor: a task is a "molecule" with functional groups (capabilities it
 * needs), and each agent is a "reagent" with the functional groups it can
 * provide. Matching is a compatibility/affinity calculation between the two,
 * analogous to how a substrate finds the right catalyst.
 *
 * Exposed API:
 *   match(task, agents) -> ranked array of matches
 *
 * A `task` may be:
 *   - a string (free text describing the work), or
 *   - an object: { id?, text?, skills?: string[], complexity?: number,
 *                  priority?: number, tags?: string[] }
 *
 * An `agent` may be:
 *   - a string (agent name), or
 *   - an object: { id?, name?, skills?: string[], capacity?: number,
 *                  load?: number, reliability?: number, latency?: number,
 *                  tags?: string[], specialties?: string[] }
 *
 * The engine produces, for every agent, an affinity score in [0, 1] built from
 * several independent "reaction channels", then ranks them.
 */

/* ------------------------------------------------------------------ *
 * Constants & defaults
 * ------------------------------------------------------------------ */

const DEFAULTS = Object.freeze({
  WEIGHT_SKILL: 0.45,
  WEIGHT_CAPACITY: 0.2,
  WEIGHT_RELIABILITY: 0.2,
  WEIGHT_LATENCY: 0.15,
  PRIORITY_BONUS: 0.1,
  MIN_SCORE: 0,
  MAX_RESULTS: Infinity,
});

const COMPLEXITY_TIERS = Object.freeze([
  { name: 'trivial', max: 0.2 },
  { name: 'light', max: 0.4 },
  { name: 'moderate', max: 0.6 },
  { name: 'heavy', max: 0.8 },
  { name: 'extreme', max: Infinity },
]);

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'by', 'at', 'from',
  'create', 'make', 'build', 'write', 'fix', 'add', 'implement', 'file',
  'please', 'need', 'needs', 'should', 'must', 'task', 'agent',
]);

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter((v) => v != null);
  if (value == null) return [];
  return [value];
}

function normalizeToken(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-+.]/g, '')
    .trim();
}

function tokenize(text) {
  if (!text && text !== 0) return [];
  return String(text)
    .toLowerCase()
    .split(/[\s,;:/\\|()[\]{}"'`]+/)
    .map(normalizeToken)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function unique(list) {
  return Array.from(new Set(list));
}

function avg(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

function complexityTier(value) {
  const v = clamp01(value);
  for (const tier of COMPLEXITY_TIERS) {
    if (v <= tier.max) return tier.name;
  }
  return 'extreme';
}

/* ------------------------------------------------------------------ *
 * Normalization of inputs
 * ------------------------------------------------------------------ */

function normalizeTask(task) {
  if (task == null) {
    return { id: 'task:anonymous', text: '', skills: [], complexity: 0.5, priority: 0.5, tags: [] };
  }
  if (typeof task === 'string') {
    const skills = unique(tokenize(task));
    return {
      id: `task:${skills.slice(0, 3).join('-') || 'text'}`,
      text: task,
      skills,
      complexity: estimateComplexity(skills),
      priority: 0.5,
      tags: [],
    };
  }
  const skills = unique([
    ...toArray(task.skills),
    ...tokenize(task.text || ''),
  ].map(normalizeToken).filter(Boolean));
  return {
    id: task.id || task.name || 'task:anonymous',
    text: task.text || '',
    skills,
    complexity: typeof task.complexity === 'number' ? clamp01(task.complexity) : estimateComplexity(skills),
    priority: typeof task.priority === 'number' ? clamp01(task.priority) : 0.5,
    tags: unique(toArray(task.tags).map(normalizeToken)),
  };
}

function normalizeAgent(agent, index) {
  if (agent == null) {
    return {
      id: `agent:${index}`,
      name: `agent:${index}`,
      skills: [],
      capacity: 1,
      load: 0,
      reliability: 0.5,
      latency: 0.5,
      tags: [],
    };
  }
  if (typeof agent === 'string') {
    return {
      id: agent,
      name: agent,
      skills: unique(tokenize(agent)),
      capacity: 1,
      load: 0,
      reliability: 0.5,
      latency: 0.5,
      tags: [],
    };
  }
  const skills = unique([
    ...toArray(agent.skills),
    ...toArray(agent.specialties),
    ...tokenize(agent.name || agent.id || ''),
  ].map(normalizeToken).filter(Boolean));
  return {
    id: agent.id || agent.name || `agent:${index}`,
    name: agent.name || agent.id || `agent:${index}`,
    skills,
    capacity: typeof agent.capacity === 'number' ? agent.capacity : 1,
    load: typeof agent.load === 'number' ? clamp01(agent.load) : 0,
    reliability: typeof agent.reliability === 'number' ? clamp01(agent.reliability) : 0.5,
    latency: typeof agent.latency === 'number' ? clamp01(agent.latency) : 0.5,
    tags: unique(toArray(agent.tags).map(normalizeToken)),
  };
}

/* ------------------------------------------------------------------ *
 * Complexity estimation from a bag of tokens
 * ------------------------------------------------------------------ */

function estimateComplexity(skills) {
  const n = Array.isArray(skills) ? skills.length : 0;
  if (n <= 1) return 0.15;
  if (n <= 3) return 0.3;
  if (n <= 6) return 0.5;
  if (n <= 10) return 0.7;
  return 0.9;
}

/* ------------------------------------------------------------------ *
 * Reaction channels — each returns a value in [0, 1]
 * ------------------------------------------------------------------ */

/**
 * Skill overlap channel: how many of the required skills the agent covers,
 * plus a bonus for exact string equality.
 */
function skillAffinity(task, agent) {
  if (!task.skills.length) return 0.5; // no requirements -> neutral
  if (!agent.skills.length) return 0.1;
  const agentSet = new Set(agent.skills);
  let hits = 0;
  for (const skill of task.skills) {
    if (agentSet.has(skill)) hits += 1;
  }
  const coverage = hits / task.skills.length;
  const density = hits / Math.max(agent.skills.length, 1);
  return clamp01(coverage * 0.75 + density * 0.25);
}

/**
 * Capacity channel: penalize overloaded agents, reward headroom.
 */
function capacityAffinity(agent) {
  const capacity = Math.max(agent.capacity, 0.0001);
  const load = clamp01(agent.load);
  const available = clamp01(1 - load);
  const fits = capacity >= 1 ? 1 : capacity;
  return clamp01(available * 0.7 + fits * 0.3);
}

/**
 * Reliability channel with a mild exponential curve so small differences
 * matter less at the extremes.
 */
function reliabilityAffinity(agent) {
  const r = clamp01(agent.reliability);
  return clamp01(Math.pow(r, 0.85));
}

/**
 * Latency channel: lower latency (0) => better (1).
 */
function latencyAffinity(agent) {
  const l = clamp01(agent.latency);
  return clamp01(1 - l);
}

/**
 * Tag channel: overlap of task tags with agent tags.
 */
function tagAffinity(task, agent) {
  if (!task.tags.length || !agent.tags.length) return 0;
  const agentTags = new Set(agent.tags);
  let hits = 0;
  for (const tag of task.tags) {
    if (agentTags.has(tag)) hits += 1;
  }
  return clamp01(hits / task.tags.length);
}

/* ------------------------------------------------------------------ *
 * Score assembly
 * ------------------------------------------------------------------ */

function computeScore(task, agent, weights) {
  const channels = {
    skill: skillAffinity(task, agent),
    capacity: capacityAffinity(agent),
    reliability: reliabilityAffinity(agent),
    latency: latencyAffinity(agent),
    tag: tagAffinity(task, agent),
  };

  const base =
    channels.skill * weights.WEIGHT_SKILL +
    channels.capacity * weights.WEIGHT_CAPACITY +
    channels.reliability * weights.WEIGHT_RELIABILITY +
    channels.latency * weights.WEIGHT_LATENCY;

  const priorityBoost = weights.PRIORITY_BONUS * clamp01(task.priority) * channels.capacity;
  const tagBoost = channels.tag * 0.1;

  const score = clamp01(base + priorityBoost + tagBoost);
  return { score, channels };
}

function mergeWeights(options) {
  const custom = isObject(options && options.weights) ? options.weights : {};
  return {
    WEIGHT_SKILL: typeof custom.skill === 'number' ? custom.skill : DEFAULTS.WEIGHT_SKILL,
    WEIGHT_CAPACITY: typeof custom.capacity === 'number' ? custom.capacity : DEFAULTS.WEIGHT_CAPACITY,
    WEIGHT_RELIABILITY: typeof custom.reliability === 'number' ? custom.reliability : DEFAULTS.WEIGHT_RELIABILITY,
    WEIGHT_LATENCY: typeof custom.latency === 'number' ? custom.latency : DEFAULTS.WEIGHT_LATENCY,
    PRIORITY_BONUS: typeof custom.priorityBonus === 'number' ? custom.priorityBonus : DEFAULTS.PRIORITY_BONUS,
  };
}

function explainMatch(task, agent, result) {
  const reasons = [];
  if (result.channels.skill >= 0.6) reasons.push('strong skill coverage');
  else if (result.channels.skill <= 0.2) reasons.push('weak skill coverage');
  if (result.channels.capacity >= 0.7) reasons.push('available capacity');
  if (result.channels.capacity <= 0.3) reasons.push('near overload');
  if (result.channels.reliability >= 0.7) reasons.push('high reliability');
  if (result.channels.latency >= 0.7) reasons.push('low latency');
  return {
    task: task.id,
    agent: agent.id,
    score: result.score,
    tier: complexityTier(task.complexity),
    reasons,
    channels: result.channels,
  };
}

/**
 * Build the full ranked match list.
 */
function buildMatches(task, agents, weights, options) {
  const list = agents.map((rawAgent, index) => {
    const agent = normalizeAgent(rawAgent, index);
    const result = computeScore(task, agent, weights);
    const normalized = options && options.normalize === true
      ? result.score
      : result.score;
    const entry = explainMatch(task, agent, result);
    entry.normalized = normalized;
    return entry;
  });

  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.agent).localeCompare(String(b.agent));
  });

  return list;
}

/**
 * Public API.
 *
 * @param {string|object} task
 * @param {Array<string|object>} agents
 * @param {object} [options]
 * @returns {Array<object>} ranked matches
 */
function match(task, agents, options) {
  const opts = isObject(options) ? options : {};
  const normalizedTask = normalizeTask(task);
  const agentList = toArray(agents);
  const weights = mergeWeights(opts);

  if (!agentList.length) {
    return [];
  }

  let matches = buildMatches(normalizedTask, agentList, weights, opts);

  if (typeof opts.minScore === 'number') {
    matches = matches.filter((m) => m.score >= opts.minScore);
  }

  if (typeof opts.limit === 'number' && opts.limit > 0) {
    matches = matches.slice(0, opts.limit);
  }

  return matches;
}

/* ------------------------------------------------------------------ *
 * Convenience helpers
 * ------------------------------------------------------------------ */

function best(task, agents, options) {
  const ranked = match(task, agents, options);
  return ranked.length ? ranked[0] : null;
}

function explain(task, agents, options) {
  return match(task, agents, options).map((m) => ({
    agent: m.agent,
    score: Number(m.score.toFixed(4)),
    tier: m.tier,
    reasons: m.reasons,
  }));
}

function scores(task, agents, options) {
  const out = {};
  for (const m of match(task, agents, options)) {
    out[m.agent] = Number(m.score.toFixed(4));
  }
  return out;
}

module.exports = {
  match,
  best,
  explain,
  scores,
  // exposed internals for testing / composition
  _internals: {
    normalizeTask,
    normalizeAgent,
    tokenize,
    estimateComplexity,
    complexityTier,
    skillAffinity,
    capacityAffinity,
    reliabilityAffinity,
    latencyAffinity,
    tagAffinity,
    computeScore,
    clamp01,
    unique,
    avg,
  },
};

/* ------------------------------------------------------------------ *
 * Self-check (only when executed directly)
 * ------------------------------------------------------------------ */

if (require.main === module) {
  const task = {
    id: 'task:demo',
    text: 'create chemistry matching module with tests and docs',
    skills: ['chemistry', 'matching', 'tests', 'docs'],
    complexity: 0.6,
    priority: 0.8,
    tags: ['backend'],
  };
  const agents = [
    { id: 'chemist-a', skills: ['chemistry', 'matching'], reliability: 0.9, latency: 0.2, tags: ['backend'] },
    { id: 'chemist-b', skills: ['docs', 'tests'], reliability: 0.6, latency: 0.4, load: 0.8 },
    { id: 'chemist-c', skills: ['chemistry', 'tests', 'docs', 'matching'], reliability: 0.8, latency: 0.3, tags: ['backend'] },
  ];
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(explain(task, agents), null, 2));
}
