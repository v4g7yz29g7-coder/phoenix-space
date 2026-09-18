# Quickstart Guide

Get up and running with the Agent Race framework in under 10 minutes. This guide covers installation, local development, building your first agent, running a race, and the core API endpoints.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running Locally](#running-locally)
- [Project Structure](#project-structure)
- [Creating Your Own Agent](#creating-your-own-agent)
- [Registering an Agent](#registering-an-agent)
- [Running a Race](#running-a-race)
- [API Endpoints](#api-endpoints)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before you begin, make sure you have the following installed:

- **Node.js** >= 18.x (LTS recommended)
- **npm** >= 9.x (ships with Node)
- **Git** >= 2.30

Verify your environment:

```bash
node --version
npm --version
git --version
```

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-org/agent-race.git
cd agent-race
npm i
```

If you plan to contribute, also install the dev tooling:

```bash
npm i --include=dev
```

Optionally copy the environment template and adjust values:

```bash
cp .env.example .env
```

> **Note:** Never commit your `.env` file. It is already listed in `.gitignore`.

## Running Locally

Start the development server with hot reload:

```bash
npm run dev
```

By default the server listens on `http://localhost:3000`. To run a production-style build:

```bash
npm run build
npm start
```

You can also start a standalone race directly from the CLI without the server:

```bash
node race.js --agents fast,deep --task "Explain recursion"
```

## Project Structure

```
agent-race/
├── agents/           # Agent definitions live here
├── docs/             # Documentation (you are here)
├── src/              # Core runtime and API
├── tests/            # Unit and integration tests
├── race.js           # CLI entry point for running a race
├── package.json
└── README.md
```

## Creating Your Own Agent

An agent is a small module that exports a `run` function. Create a new file under `agents/`:

```js
// agents/hello_agent.js
export const meta = {
  name: "hello",
  description: "A minimal example agent",
  tags: ["example", "starter"],
};

export async function run({ task, context }) {
  // Your logic goes here. Return a structured result.
  const answer = `Hello! I received the task: "${task}"`;
  return {
    agent: meta.name,
    output: answer,
    meta: { tokens: answer.length, elapsedMs: 0 },
  };
}
```

### Agent Contract

Every agent must return an object with the following shape:

```ts
interface AgentResult {
  agent: string;      // Unique agent name
  output: string;     // Human-readable result
  meta?: {
    tokens?: number;  // Optional token count
    elapsedMs?: number;
    score?: number;   // Optional self-assessed score
  };
}
```

Tips for a good agent:

- Keep `run` pure where possible; avoid hidden global state.
- Respect the `context` object for shared configuration and timeouts.
- Throw descriptive errors instead of returning `undefined`.

## Registering an Agent

Add your agent to the registry so the runtime can discover it:

```js
// agents/index.js
import * as hello from "./hello_agent.js";
import * as fast from "./fast_agent.js";
import * as deep from "./deep_agent.js";

export const registry = {
  hello: hello.run,
  fast: fast.run,
  deep: deep.run,
};
```

The keys of `registry` are the names you will pass to the race runner.

## Running a Race

Race two or more agents against the same task and compare their results:

```bash
node race.js --agents fast,deep --task "Summarize the CAP theorem"
```

Programmatic usage:

```js
import { runRace } from "./src/race.js";

const result = await runRace({
  task: "Summarize the CAP theorem",
  agents: ["fast", "deep"],
  timeoutMs: 5000,
});

console.log(result.winner);
console.log(result.results);
```

Common CLI flags:

| Flag          | Description                             | Default |
| ------------- | --------------------------------------- | ------- |
| `--agents`    | Comma-separated agent names             | all     |
| `--task`      | The task prompt                         | prompt  |
| `--timeoutMs` | Per-agent timeout in milliseconds       | 30000   |
| `--json`      | Emit machine-readable JSON output       | false   |

## API Endpoints

When the server is running you can interact with it over HTTP.

### `GET /api/health`

Returns service status.

```bash
curl http://localhost:3000/api/health
```

```json
{ "status": "ok", "uptime": 42.7 }
```

### `GET /api/agents`

Lists all registered agents.

```bash
curl http://localhost:3000/api/agents
```

### `POST /api/race`

Starts a race and returns the winner plus all results.

```bash
curl -X POST http://localhost:3000/api/race \
  -H "Content-Type: application/json" \
  -d '{"task":"Explain recursion","agents":["fast","deep"]}'
```

Example response:

```json
{
  "winner": "deep",
  "results": [
    { "agent": "fast", "output": "..." },
    { "agent": "deep", "output": "..." }
  ]
}
```

### `GET /api/race/:id`

Fetches the status or result of a previously started race.

```bash
curl http://localhost:3000/api/race/abc123
```

## Testing

Run the full test suite:

```bash
npm test
```

Run a single test file:

```bash
npx node --test tests/race.test.js
```

## Troubleshooting

- **`Error: Cannot find module`** — run `npm i` again and check your Node version.
- **Port already in use** — set `PORT=3001 npm run dev` or kill the conflicting process.
- **Agent not found in registry** — make sure it is exported from `agents/index.js`.
- **Race times out** — increase `--timeoutMs` or optimize the slow agent.

For deeper topics see the [API reference](./api.md) and [architecture notes](./architecture.md).
