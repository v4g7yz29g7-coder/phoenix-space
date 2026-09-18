/**
 * ЗАДАЧА 6.2 — СХЕМА БД (Platform schema registry + DDL + mappers), FORMULA I1
 * ============================================================================
 * Единая типизированная схема данных для всей платформы. До этого файла
 * таблицы жили «де-факто» в разных flat-JSON форматах:
 *
 *   • memory/auth_users.json    -> учётки пилотов (id/email/name/salt/hash/createdAt)
 *   • boxes/agent_N/BOX_META.json -> агент-боксы (name/created_at/created_by/...)
 *   • memory/patterns/race_*.json -> гонки + результаты (race_id/results[])
 *   • arena_roadmap.json        -> задачи (id/stage/title/assignee/status/hours)
 *   • skills/*.md               -> скиллы (file/title/purpose)
 *
 * Здесь они сведены в ОДНУ реляционную схему: row-типы, реестр таблиц / колонок
 * / индексов, генератор SQL-DDL (sqlite | postgres), проверка целостности и
 * мапперы «JSON-документ -> строки таблиц». Это контракт для бэкенда
 * `web/server.js` при миграции с flat-JSON на SQL.
 *
 * Совет Оракула: секреты (salt/hash, JWT_SECRET) — только на бэкенде. В схеме
 * они помечены `secret` и НИКОГДА не попадают в публичные select-проекции
 * (`PILOT_PUBLIC_COLUMNS`). React читает лишь публичные поля.
 *
 * Reference: web/server.js (register/login/me), research/audit.md (домен гонки).
 * ============================================================================
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';

/** Версия схемы — поднимается при любой несовместимой миграции. */
export const DB_SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/*  1. Типы строк (row-типы)                                                  */
/* -------------------------------------------------------------------------- */

export type PartCategory = 'engine' | 'aero' | 'tyres' | 'brakes' | 'suspension';
export type RoadmapStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type FlagKind = 'green' | 'yellow' | 'red' | 'blue' | 'checkered' | 'safety';

/** Учётная запись пилота (memory/auth_users.json, POST /api/auth/register). */
export interface PilotRow {
  id: string;
  email: string;
  name: string | null;
  salt: string;
  hash: string;
  created_at: number | null;
}

/** Агент-бокс (boxes/agent_N/BOX_META.json). PK — имя папки. */
export interface AgentRow {
  name: string;
  created_at: number | null;
  created_by: string | null;
  parent_commit: string | null;
  everos_user_id: string | null;
  strategy: string | null;
  skills_count: number;
}

/** Команда / ливрея (TeamLivery.tsx). */
export interface TeamRow {
  id: string;
  name: string;
  number: number;
  paint: string;
  accent: string;
  trim: string;
}

/** Гонка (memory/patterns/race_*.json, верхний уровень). */
export interface RaceRow {
  race_id: string;
  ts: number;
  type: string;
  task: string;
  winner: string | null;
  winner_score: number | null;
  winner_time: number | null;
}

/** Результат агента в гонке (race.results[]). Композитный PK. */
export interface RaceResultRow {
  race_id: string;
  box: string;
  score: number | null;
  time_ms: number | null;
  ok: boolean;
}

/** Тюнинг-деталь (PartsCatalog.tsx / TuningMarket.tsx). */
export interface TuningPartRow {
  id: string;
  name: string;
  category: PartCategory;
  tier: number;
  price: number;
  stats: Record<string, number>;
}

/** Сборка болида (Build). */
export interface BuildRow {
  id: string;
  owner: string;
  name: string;
  created_at: number;
  total_price: number;
}

/** Слот сборки (BuildItem). */
export interface BuildItemRow {
  build_id: string;
  slot: PartCategory;
  part_id: string;
}

/** Скилл (skills/*.md). */
export interface SkillRow {
  file: string;
  title: string;
  purpose: string;
}

/** Событие флага маршала (FlagSync.tsx / flag_status.json). */
export interface FlagEventRow {
  id: string;
  ts: number;
  flag: FlagKind;
  agent: string | null;
  note: string | null;
}

/** Задача дорожной карты (arena_roadmap.json). */
export interface RoadmapTaskRow {
  id: string;
  stage: string;
  title: string;
  assignee: string;
  status: RoadmapStatus;
  hours: number;
  file: string | null;
  retry_count: number;
  started_at: number | null;
  completed_at: number | null;
}

/* -------------------------------------------------------------------------- */
/*  2. Реестр схемы: таблицы / колонки / индексы                              */
/* -------------------------------------------------------------------------- */

export type ColumnType =
  | 'uuid'
  | 'text'
  | 'int'
  | 'bigint'
  | 'epoch_ms'
  | 'real'
  | 'bool'
  | 'json';

export interface ColumnRef {
  table: string;
  column: string;
}

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  pk?: boolean;
  unique?: boolean;
  nullable?: boolean;
  /** Исключается из публичных проекций (пароли, хэши). */
  secret?: boolean;
  default?: string | number | boolean;
  ref?: ColumnRef;
  enumOf?: readonly string[];
  comment?: string;
}

export interface IndexSpec {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface TableSpec {
  name: string;
  comment: string;
  columns: ColumnSpec[];
  indexes?: IndexSpec[];
}

/** Полный реестр — единственный источник правды по структуре БД. */
export const DB_SCHEMA: readonly TableSpec[] = [
  {
    name: 'pilots',
    comment: 'Учётные записи пилотов (бывш. memory/auth_users.json)',
    columns: [
      { name: 'id', type: 'uuid', pk: true, comment: 'crypto.randomUUID()' },
      { name: 'email', type: 'text', unique: true, comment: 'lowercased' },
      { name: 'name', type: 'text', nullable: true },
      { name: 'salt', type: 'text', secret: true, comment: 'scrypt salt, hex' },
      { name: 'hash', type: 'text', secret: true, comment: 'scrypt hash, hex' },
      { name: 'created_at', type: 'epoch_ms', nullable: true },
    ],
    indexes: [{ name: 'ux_pilots_email', columns: ['email'], unique: true }],
  },
  {
    name: 'agents',
    comment: 'Агент-боксы (бывш. boxes/agent_N/BOX_META.json)',
    columns: [
      { name: 'name', type: 'text', pk: true, comment: 'папка agent_N' },
      { name: 'created_at', type: 'epoch_ms', nullable: true },
      { name: 'created_by', type: 'text', nullable: true, ref: { table: 'agents', column: 'name' } },
      { name: 'parent_commit', type: 'text', nullable: true },
      { name: 'everos_user_id', type: 'text', nullable: true },
      { name: 'strategy', type: 'text', nullable: true },
      { name: 'skills_count', type: 'int', default: 0 },
    ],
    indexes: [{ name: 'ix_agents_created_by', columns: ['created_by'] }],
  },
  {
    name: 'teams',
    comment: 'Команды / ливреи (TeamLivery.tsx)',
    columns: [
      { name: 'id', type: 'text', pk: true },
      { name: 'name', type: 'text' },
      { name: 'number', type: 'int' },
      { name: 'paint', type: 'text' },
      { name: 'accent', type: 'text' },
      { name: 'trim', type: 'text' },
    ],
  },
  {
    name: 'races',
    comment: 'Гонки (бывш. memory/patterns/race_*.json)',
    columns: [
      { name: 'race_id', type: 'text', pk: true },
      { name: 'ts', type: 'epoch_ms' },
      { name: 'type', type: 'text', default: 'race' },
      { name: 'task', type: 'text' },
      { name: 'winner', type: 'text', nullable: true, ref: { table: 'agents', column: 'name' } },
      { name: 'winner_score', type: 'real', nullable: true },
      { name: 'winner_time', type: 'int', nullable: true, comment: 'ms' },
    ],
    indexes: [{ name: 'ix_races_ts', columns: ['ts'] }],
  },
  {
    name: 'race_results',
    comment: 'Результаты агентов в гонке (race.results[])',
    columns: [
      { name: 'race_id', type: 'text', pk: true, ref: { table: 'races', column: 'race_id' } },
      { name: 'box', type: 'text', pk: true, ref: { table: 'agents', column: 'name' } },
      { name: 'score', type: 'real', nullable: true },
      { name: 'time_ms', type: 'int', nullable: true },
      { name: 'ok', type: 'bool', default: true },
    ],
    indexes: [{ name: 'ix_results_box', columns: ['box'] }],
  },
  {
    name: 'tuning_parts',
    comment: 'Каталог тюнинга (PartsCatalog.tsx / TuningMarket.tsx)',
    columns: [
      { name: 'id', type: 'text', pk: true },
      { name: 'name', type: 'text' },
      { name: 'category', type: 'text', enumOf: ['engine', 'aero', 'tyres', 'brakes', 'suspension'] },
      { name: 'tier', type: 'int', default: 1 },
      { name: 'price', type: 'int', default: 0 },
      { name: 'stats', type: 'json', default: '{}' },
    ],
    indexes: [{ name: 'ix_parts_category', columns: ['category'] }],
  },
  {
    name: 'builds',
    comment: 'Сборки болида',
    columns: [
      { name: 'id', type: 'text', pk: true },
      { name: 'owner', type: 'text', ref: { table: 'agents', column: 'name' } },
      { name: 'name', type: 'text' },
      { name: 'created_at', type: 'epoch_ms' },
      { name: 'total_price', type: 'int', default: 0 },
    ],
    indexes: [{ name: 'ix_builds_owner', columns: ['owner'] }],
  },
  {
    name: 'build_items',
    comment: 'Слоты сборки (BuildItem). Композитный PK.',
    columns: [
      { name: 'build_id', type: 'text', pk: true, ref: { table: 'builds', column: 'id' } },
      { name: 'slot', type: 'text', pk: true, enumOf: ['engine', 'aero', 'tyres', 'brakes', 'suspension'] },
      { name: 'part_id', type: 'text', ref: { table: 'tuning_parts', column: 'id' } },
    ],
  },
  {
    name: 'skills',
    comment: 'Скиллы (skills/*.md)',
    columns: [
      { name: 'file', type: 'text', pk: true },
      { name: 'title', type: 'text' },
      { name: 'purpose', type: 'text' },
    ],
  },
  {
    name: 'flag_events',
    comment: 'События флагов маршала (FlagSync.tsx / flag_status.json)',
    columns: [
      { name: 'id', type: 'uuid', pk: true },
      { name: 'ts', type: 'epoch_ms' },
      { name: 'flag', type: 'text', enumOf: ['green', 'yellow', 'red', 'blue', 'checkered', 'safety'] },
      { name: 'agent', type: 'text', nullable: true, ref: { table: 'agents', column: 'name' } },
      { name: 'note', type: 'text', nullable: true },
    ],
    indexes: [{ name: 'ix_flags_ts', columns: ['ts'] }],
  },
  {
    name: 'roadmap_tasks',
    comment: 'Задачи дорожной карты (arena_roadmap.json)',
    columns: [
      { name: 'id', type: 'text', pk: true, comment: "'6.2'" },
      { name: 'stage', type: 'text' },
      { name: 'title', type: 'text' },
      { name: 'assignee', type: 'text' },
      { name: 'status', type: 'text', enumOf: ['pending', 'in_progress', 'completed', 'failed'], default: 'pending' },
      { name: 'hours', type: 'real', default: 0 },
      { name: 'file', type: 'text', nullable: true },
      { name: 'retry_count', type: 'int', default: 0 },
      { name: 'started_at', type: 'epoch_ms', nullable: true },
      { name: 'completed_at', type: 'epoch_ms', nullable: true },
    ],
    indexes: [{ name: 'ix_roadmap_status', columns: ['status'] }],
  },
];

/* -------------------------------------------------------------------------- */
/*  3. Публичные проекции (секреты исключены)                                 */
/* -------------------------------------------------------------------------- */

export function publicColumns(table: TableSpec): ColumnSpec[] {
  return table.columns.filter((c) => !c.secret);
}

function tableByName(name: string): TableSpec | undefined {
  return DB_SCHEMA.find((t) => t.name === name);
}

/** Публичные колонки pilots для API-ответа (web/server.js::publicUser). */
export const PILOT_PUBLIC_COLUMNS: readonly string[] = (() => {
  const t = tableByName('pilots');
  return t ? publicColumns(t).map((c) => c.name) : [];
})();

/* -------------------------------------------------------------------------- */
/*  4. Генератор DDL (sqlite | postgres)                                      */
/* -------------------------------------------------------------------------- */

export type SqlDialect = 'sqlite' | 'postgres';

const SQL_TYPES: Record<SqlDialect, Record<ColumnType, string>> = {
  sqlite: {
    uuid: 'TEXT',
    text: 'TEXT',
    int: 'INTEGER',
    bigint: 'INTEGER',
    epoch_ms: 'INTEGER',
    real: 'REAL',
    bool: 'INTEGER',
    json: 'TEXT',
  },
  postgres: {
    uuid: 'UUID',
    text: 'TEXT',
    int: 'INTEGER',
    bigint: 'BIGINT',
    epoch_ms: 'BIGINT',
    real: 'DOUBLE PRECISION',
    bool: 'BOOLEAN',
    json: 'JSONB',
  },
};

function defaultLiteral(dialect: SqlDialect, value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return dialect === 'sqlite' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** SQL одной колонки. */
export function columnSql(dialect: SqlDialect, col: ColumnSpec): string {
  const parts = [col.name, SQL_TYPES[dialect][col.type]];
  if (col.pk || !col.nullable) parts.push('NOT NULL');
  if (col.unique) parts.push('UNIQUE');
  if (col.default !== undefined) parts.push(`DEFAULT ${defaultLiteral(dialect, col.default)}`);
  if (col.ref) parts.push(`REFERENCES ${col.ref.table}(${col.ref.column})`);
  return '  ' + parts.join(' ');
}

/** SQL CREATE TABLE: колонки + составной PK + REFERENCES. */
export function createTableSql(dialect: SqlDialect, table: TableSpec): string {
  const lines = table.columns.map((c) => columnSql(dialect, c));
  const pks = table.columns.filter((c) => c.pk).map((c) => c.name);
  if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${lines.join(',\n')}\n);`;
}

/** Полный DDL базы для выбранного диалекта + индексы. */
export function createSchemaSql(dialect: SqlDialect = 'sqlite'): string {
  const out: string[] = [
    `-- DbSchema v${DB_SCHEMA_VERSION} (${dialect}) — generated, do not edit by hand`,
  ];
  for (const t of DB_SCHEMA) {
    out.push('');
    out.push(`-- ${t.comment}`);
    out.push(createTableSql(dialect, t));
    for (const ix of t.indexes || []) {
      const uniq = ix.unique ? 'UNIQUE ' : '';
      out.push(`CREATE ${uniq}INDEX IF NOT EXISTS ${ix.name} ON ${t.name} (${ix.columns.join(', ')});`);
    }
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  5. Целостность схемы                                                      */
/* -------------------------------------------------------------------------- */

/** Проверка ссылок/типов реестра: каждая FK указывает на существующую колонку. */
export function validateSchema(schema: readonly TableSpec[] = DB_SCHEMA): string[] {
  const problems: string[] = [];
  const seenTables = new Set<string>();

  for (const t of schema) {
    if (seenTables.has(t.name)) problems.push(`duplicate table: ${t.name}`);
    seenTables.add(t.name);

    const cols = new Set<string>();
    for (const c of t.columns) {
      if (cols.has(c.name)) problems.push(`${t.name}: duplicate column ${c.name}`);
      cols.add(c.name);
    }

    if (!t.columns.some((c) => c.pk)) problems.push(`${t.name}: no primary key`);

    for (const c of t.columns) {
      if (c.unique && c.pk) problems.push(`${t.name}.${c.name}: unique redundant with pk`);
      if (c.enumOf && c.type !== 'text') problems.push(`${t.name}.${c.name}: enumOf on non-text`);
      if (!c.ref) continue;
      const target = schema.find((x) => x.name === c.ref!.table);
      if (!target) {
        problems.push(`${t.name}.${c.name}: FK -> missing table ${c.ref.table}`);
      } else if (!target.columns.some((x) => x.name === c.ref!.column)) {
        problems.push(`${t.name}.${c.name}: FK -> missing column ${c.ref.table}.${c.ref.column}`);
      }
    }

    for (const ix of t.indexes || []) {
      for (const ic of ix.columns) {
        if (!cols.has(ic)) problems.push(`${t.name}: index ${ix.name} on missing column ${ic}`);
      }
    }
  }
  return problems;
}

/** Агрегат статистики реестра для HUD. */
export function schemaStats(schema: readonly TableSpec[] = DB_SCHEMA) {
  let columns = 0;
  let foreignKeys = 0;
  let indexes = 0;
  let secrets = 0;
  for (const t of schema) {
    columns += t.columns.length;
    foreignKeys += t.columns.filter((c) => !!c.ref).length;
    indexes += (t.indexes || []).length;
    secrets += t.columns.filter((c) => !!c.secret).length;
  }
  return { tables: schema.length, columns, foreignKeys, indexes, secrets };
}

/* -------------------------------------------------------------------------- */
/*  6. Мапперы: JSON-документ -> строки таблиц                                */
/* -------------------------------------------------------------------------- */

/** Запись из memory/auth_users.json -> строка pilots. */
export function pilotFromAccount(email: string, acc: any): PilotRow {
  return {
    id: String(acc?.id ?? email),
    email: email.toLowerCase(),
    name: acc?.name ?? null,
    salt: String(acc?.salt ?? ''),
    hash: String(acc?.hash ?? ''),
    created_at: typeof acc?.createdAt === 'number' ? acc.createdAt : null,
  };
}

/** BOX_META.json -> строка agents. */
export function agentFromBoxMeta(name: string, meta: any): AgentRow {
  return {
    name,
    created_at: typeof meta?.created_at === 'number' ? meta.created_at : null,
    created_by: meta?.created_by ?? null,
    parent_commit: meta?.parent_commit ?? null,
    everos_user_id: meta?.everos_user_id ?? null,
    strategy: meta?.strategy ?? null,
    skills_count: Number(meta?.skills_count ?? 0),
  };
}

/** race_*.json -> строки races + race_results. */
export function raceFromPattern(doc: any): { race: RaceRow; results: RaceResultRow[] } {
  const race: RaceRow = {
    race_id: String(doc?.race_id ?? doc?.id ?? ''),
    ts: Number(doc?.ts ?? Date.now()),
    type: String(doc?.type ?? 'race'),
    task: String(doc?.task ?? ''),
    winner: doc?.winner ?? null,
    winner_score: typeof doc?.winner_score === 'number' ? doc.winner_score : null,
    winner_time: typeof doc?.winner_time === 'number' ? doc.winner_time : null,
  };
  const raw = Array.isArray(doc?.results) ? doc.results : [];
  const results: RaceResultRow[] = raw.map((r: any) => ({
    race_id: race.race_id,
    box: String(r?.box ?? r?.agent ?? ''),
    score: typeof r?.score === 'number' ? r.score : null,
    time_ms: typeof r?.time === 'number' ? r.time : null,
    ok: r?.ok !== false,
  }));
  return { race, results };
}

/** Разбор arena_roadmap.json целиком -> строки roadmap_tasks. */
export function roadmapTasksFromJson(doc: any): RoadmapTaskRow[] {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.tasks) ? doc.tasks : [];
  return list.map((t: any) => {
    const started = t?.started_at ?? null;
    const completed = t?.completed_at ?? null;
    return {
      id: String(t?.id ?? ''),
      stage: String(t?.stage ?? ''),
      title: String(t?.title ?? ''),
      assignee: String(t?.assignee ?? 'мы'),
      status: (t?.status ?? 'pending') as RoadmapStatus,
      hours: Number(t?.hours ?? 0),
      file: t?.file ?? null,
      retry_count: Number(t?.retry_count ?? 0),
      started_at: typeof started === 'number' ? started : null,
      completed_at: typeof completed === 'number' ? completed : null,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  7. Точечная валидация строки перед INSERT                                 */
/* -------------------------------------------------------------------------- */

/** Проверка одной строки против реестра: типы, обязательность, enum, FK-непустота. */
export function validateRow(table: TableSpec, row: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const col of table.columns) {
    const value = row[col.name];
    const missing = value === undefined || value === null;
    if (missing) {
      if (col.pk || !col.nullable) {
        if (col.default === undefined) errors.push(`${table.name}.${col.name}: required`);
      }
      continue;
    }
    if (col.enumOf && !col.enumOf.includes(String(value))) {
      errors.push(`${table.name}.${col.name}: '${String(value)}' not in enum`);
    }
    const t = col.type;
    if ((t === 'int' || t === 'bigint' || t === 'epoch_ms') && typeof value !== 'number') {
      errors.push(`${table.name}.${col.name}: expected number`);
    }
    if (t === 'real' && typeof value !== 'number') {
      errors.push(`${table.name}.${col.name}: expected number`);
    }
    if (t === 'bool' && typeof value !== 'boolean') {
      errors.push(`${table.name}.${col.name}: expected boolean`);
    }
  }
  return errors;
}

/* -------------------------------------------------------------------------- */
/*  8. План миграций flat-JSON -> SQL                                         */
/* -------------------------------------------------------------------------- */

export interface MigrationStep {
  version: number;
  name: string;
  from: string;
  to: string;
  mapper: string;
}

export const MIGRATION_PLAN: readonly MigrationStep[] = [
  { version: 1, name: 'pilots', from: 'memory/auth_users.json', to: 'pilots', mapper: 'pilotFromAccount' },
  { version: 2, name: 'agents', from: 'boxes/agent_N/BOX_META.json', to: 'agents', mapper: 'agentFromBoxMeta' },
  { version: 3, name: 'races', from: 'memory/patterns/race_*.json', to: 'races + race_results', mapper: 'raceFromPattern' },
  { version: 4, name: 'roadmap', from: 'arena_roadmap.json', to: 'roadmap_tasks', mapper: 'roadmapTasksFromJson' },
];

/* -------------------------------------------------------------------------- */
/*  9. React: хук + LED-стела со схемой в арене                               */
/* -------------------------------------------------------------------------- */

const BOARD_BG = '#0b1220';
const BOARD_ACCENT = '#38bdf8';
const BOARD_DIM = '#94a3b8';

/** Единый доступ компонентов к реестру: статистика, DDL и диагноз целостности. */
export function useDbSchema(dialect: SqlDialect = 'sqlite') {
  return useMemo(() => {
    const problems = validateSchema(DB_SCHEMA);
    const stats = schemaStats(DB_SCHEMA);
    const ddl = createSchemaSql(dialect);
    return { schema: DB_SCHEMA, stats, problems, ddl, healthy: problems.length === 0 };
  }, [dialect]);
}

export interface DbSchemaBoardProps {
  position?: [number, number, number];
  dialect?: SqlDialect;
  /** Сколько первых таблиц показать на экране (остальные — счётчиком). */
  maxTables?: number;
}

export function DbSchemaBoard({
  position = [0, 0, 0],
  maxTables = 8,
  dialect = 'sqlite',
}: DbSchemaBoardProps) {
  const { stats, problems } = useDbSchema(dialect);
  const frameRef = useRef<THREE.Mesh>(null);

  const rows = useMemo(() => DB_SCHEMA.slice(0, maxTables), [maxTables]);
  const healthy = problems.length === 0;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const mesh = frameRef.current;
    if (mesh) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 + Math.sin(t * 1.6) * 0.15;
    }
  });

  return (
    <group position={position}>
      {/* Задник экрана */}
      <mesh position={[0, 3.2, -0.02]}>
        <planeGeometry args={[7.4, 6.4]} />
        <meshBasicMaterial color={BOARD_BG} transparent opacity={0.92} />
      </mesh>

      {/* Пульсирующая рамка */}
      <mesh ref={frameRef} position={[0, 3.2, 0]}>
        <planeGeometry args={[7.5, 6.5]} />
        <meshBasicMaterial color={BOARD_ACCENT} transparent opacity={0.6} wireframe />
      </mesh>

      {/* Заголовок */}
      <Text position={[0, 6.0, 0.03]} fontSize={0.42} color={BOARD_ACCENT} anchorX="center">
        {`DB SCHEMA v${DB_SCHEMA_VERSION}`}
      </Text>
      <Text position={[0, 5.5, 0.03]} fontSize={0.2} color={BOARD_DIM} anchorX="center">
        {`${stats.tables} tables · ${stats.columns} cols · ${stats.foreignKeys} FK · ${dialect}`}
      </Text>

      {/* Список таблиц */}
      {rows.map((t, i) => (
        <group key={t.name} position={[-3.3, 4.85 - i * 0.52, 0.03]}>
          <Text fontSize={0.22} color={BOARD_ACCENT} anchorX="left">
            {t.name}
          </Text>
          <Text position={[4.4, 0, 0]} fontSize={0.18} color={BOARD_DIM} anchorX="right">
            {`${t.columns.length}c${(t.indexes || []).length ? ` · ${(t.indexes || []).length}ix` : ''}`}
          </Text>
        </group>
      ))}

      {DB_SCHEMA.length > maxTables && (
        <Text position={[0, 4.85 - maxTables * 0.52, 0.03]} fontSize={0.18} color={BOARD_DIM} anchorX="center">
          {`+${DB_SCHEMA.length - maxTables} ...`}
        </Text>
      )}

      {/* Диагноз целостности */}
      <Text position={[0, 0.55, 0.03]} fontSize={0.2} color={healthy ? '#22c55e' : '#ef4444'} anchorX="center">
        {healthy ? 'INTEGRITY OK' : `PROBLEMS: ${problems.length}`}
      </Text>
    </group>
  );
}

export default {
  DB_SCHEMA,
  DB_SCHEMA_VERSION,
  PILOT_PUBLIC_COLUMNS,
  MIGRATION_PLAN,
  createSchemaSql,
  createTableSql,
  columnSql,
  validateSchema,
  validateRow,
  schemaStats,
  publicColumns,
  pilotFromAccount,
  agentFromBoxMeta,
  raceFromPattern,
  roadmapTasksFromJson,
  useDbSchema,
  DbSchemaBoard,
};
