export interface RaceAgent {
  name: string;
  avatar?: string;
  color: string;
}

export interface RaceStartEvent {
  type: 'race:start';
  race_id: string;
  agents: RaceAgent[];
  task: string;
}

export interface RaceTickEvent {
  type: 'race:tick';
  race_id: string;
  t: number;
  positions: Array<{
    agent: string;
    progress: number;
    status: 'idle' | 'running' | 'done' | 'failed';
  }>;
}

export interface RaceFinishEvent {
  type: 'race:finish';
  race_id: string;
  winner: string;
  results: Array<{
    agent: string;
    time_ms: number;
    score: number;
    ok: boolean;
  }>;
}

export interface RadioEvent {
  type: 'comment';
  text: string;
  winner?: string;
  score?: number;
  time_ms?: number;
  boxes?: number;
  ts: number;
}

export type ArenaEvent = RaceStartEvent | RaceTickEvent | RaceFinishEvent;
