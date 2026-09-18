import { create } from 'zustand';
import type { RaceAgent, RadioEvent } from '../types/events';

interface AgentState extends RaceAgent {
  progress: number;
  status: 'idle' | 'running' | 'done' | 'failed';
  score: number;
}

interface ArenaStore {
  connected: boolean;
  raceId: string | null;
  task: string;
  agents: Record<string, AgentState>;
  radioEvents: RadioEvent[];
  setConnected: (v: boolean) => void;
  onRaceStart: (raceId: string, agents: RaceAgent[], task: string) => void;
  onRaceTick: (positions: Array<{ agent: string; progress: number; status: any }>) => void;
  onRaceFinish: (winner: string, results: Array<{ agent: string; score: number; ok: boolean }>) => void;
  onRadioEvent: (e: RadioEvent) => void;
  addMockAgents: () => void;
}

const COLORS = ['#4dd0ff', '#ff7eb6', '#a855f7', '#6eff8b', '#ffd700', '#ff5c5c', '#7dd3fc', '#fb923c'];

export const useArena = create<ArenaStore>((set) => ({
  connected: false,
  raceId: null,
  task: '',
  agents: {},
  radioEvents: [],

  setConnected: (v) => set({ connected: v }),

  onRaceStart: (raceId, agents, task) =>
    set(() => {
      const map: Record<string, AgentState> = {};
      agents.forEach((a) => {
        map[a.name] = { ...a, progress: 0, status: 'idle', score: 0 };
      });
      return { raceId, task, agents: map };
    }),

  onRaceTick: (positions) =>
    set((s) => {
      const agents = { ...s.agents };
      positions.forEach((p) => {
        if (agents[p.agent]) {
          agents[p.agent] = { ...agents[p.agent], progress: p.progress, status: p.status };
        }
      });
      return { agents };
    }),

  onRaceFinish: (winner, results) =>
    set((s) => {
      const agents = { ...s.agents };
      results.forEach((r) => {
        if (agents[r.agent]) {
          agents[r.agent] = { ...agents[r.agent], score: r.score, status: r.ok ? 'done' : 'failed' };
        }
      });
      return { agents };
    }),

  onRadioEvent: (e) =>
    set((s) => ({ radioEvents: [e, ...s.radioEvents].slice(0, 50) })),

  addMockAgents: () => {
    const mock = ['agent_1', 'agent_4', 'agent_7', 'agent_20', 'agent_6', 'agent_23'];
    const agents: Record<string, AgentState> = {};
    mock.forEach((name, i) => {
      agents[name] = {
        name,
        color: COLORS[i % COLORS.length],
        progress: 0,
        status: 'idle',
        score: 0,
      };
    });
    set({ raceId: 'mock_race', agents, task: 'Mock: csv-to-parquet' });
  },
}));
