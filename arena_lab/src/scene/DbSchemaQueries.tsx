/**
 * ЗАДАЧА 6.2 — СХЕМА БД · DML-СЛОЙ (параметризованные запросы) · FORMULA I1
 * ============================================================================
 * DbSchema.tsx владеет реестром (`DB_SCHEMA`) и генерирует DDL (CREATE TABLE /
 * CREATE INDEX). Но бэкенду `web/server.js` для перехода с flat-JSON на SQL
 * нужен ещё и DML: какие именно INSERT / UPSERT / SELECT / DELETE выполнять и
 * сколько у них bind-параметров.
 *
 * Этот файл выводит параметризованный DML ИЗ ТОГО ЖЕ реестра — значит схема
 * остаётся ЕДИНСТВЕННЫМ источником правды: поменял колонку в `DbSchema.tsx`
 * (или добавил таблицу) — DDL и DML обновились синхронно, рассинхрона нет.
 *
 * Совет Оракула: секреты (salt/hash) НИКОГДА не попадают в публичные SELECT —
 * проекции строятся через `publicColumns()`, а не через `SELECT *`. INSERT же
 * принимает все колонки (секреты пишет только бэкенд при регистрации).
 *
 * Reference: arena_lab/src/scene/DbSchema.tsx, web/server.js, research/audit.md.
 * ============================================================================
 */

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  DB_SCHEMA,
  DB_SCHEMA_VERSION,
  publicColumns,
  validateSchema,
} from './DbSchema';
import type { ColumnSpec, SqlDialect, TableSpec } from './DbSchema';

/* -------------------------------------------------------------------------- */
/*  1. Примитивы генерации SQL                                                */
/* -------------------------------------------------------------------------- */

/** Экранирование идентификатора (works in sqlite and postgres). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Список bind-параметров: sqlite `?` / postgres `$1, $2 ...`. */
export function placeholders(dialect: SqlDialect, count: number, start = 1): string {
  if (count <= 0) return '';
  if (dialect === 'postgres') {
    return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
  }
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Колонки первичного ключа (может быть составной). */
export function pkColumns(table: TableSpec): ColumnSpec[] {
  return table.columns.filter((c) => c.pk);
}

/** Колонки для INSERT — всё, кроме PK с DB-дефолтом. */
export function insertColumns(table: TableSpec): ColumnSpec[] {
  return table.columns.filter((c) => !(c.pk && c.default !== undefined));
}

/** Колонки для DO UPDATE — всё, кроме PK. */
export function updateColumns(table: TableSpec): ColumnSpec[] {
  const pks = new Set(pkColumns(table).map((c) => c.name));
  return table.columns.filter((c) => !pks.has(c.name));
}

/** Публичная проекция (без секретов) в виде списка идентификаторов. */
export function publicSelectList(table: TableSpec): string {
  return publicColumns(table)
    .map((c) => quoteIdent(c.name))
    .join(', ');
}

/* -------------------------------------------------------------------------- */
/*  2. Генераторы отдельных DML-запросов                                      */
/* -------------------------------------------------------------------------- */

/** Полный INSERT со всеми колонками. Порядок параметров = insertColumns(). */
export function insertSql(table: TableSpec, dialect: SqlDialect): string {
  const cols = insertColumns(table);
  const names = cols.map((c) => quoteIdent(c.name)).join(', ');
  return (
    `INSERT INTO ${quoteIdent(table.name)} (${names})\n` +
    `VALUES (${placeholders(dialect, cols.length)});`
  );
}

/**
 * Идемпотентный UPSERT. `ON CONFLICT (<pk>) DO UPDATE ... excluded` работает
 * и в SQLite (>=3.24), и в PostgreSQL — один шаблон на оба диалекта.
 */
export function upsertSql(table: TableSpec, dialect: SqlDialect): string {
  const cols = insertColumns(table);
  const names = cols.map((c) => quoteIdent(c.name)).join(', ');
  const conflict = pkColumns(table)
    .map((c) => quoteIdent(c.name))
    .join(', ');
  const upd = updateColumns(table);
  const setList = upd
    .map((c) => `${quoteIdent(c.name)} = excluded.${quoteIdent(c.name)}`)
    .join(', ');
  const tail = setList
    ? `ON CONFLICT (${conflict}) DO UPDATE SET ${setList}`
    : `ON CONFLICT (${conflict}) DO NOTHING`;
  return (
    `INSERT INTO ${quoteIdent(table.name)} (${names})\n` +
    `VALUES (${placeholders(dialect, cols.length)})\n${tail};`
  );
}

/** SELECT публичной проекции по PK (строка или одна из составного ключа). */
export function selectByPkSql(table: TableSpec, dialect: SqlDialect): string {
  const where = pkColumns(table)
    .map((c, i) => `${quoteIdent(c.name)} = ${placeholders(dialect, 1, i + 1)}`)
    .join(' AND ');
  return (
    `SELECT ${publicSelectList(table)}\n` +
    `FROM ${quoteIdent(table.name)}\nWHERE ${where};`
  );
}

/** DELETE по PK. */
export function deleteByPkSql(table: TableSpec, dialect: SqlDialect): string {
  const where = pkColumns(table)
    .map((c, i) => `${quoteIdent(c.name)} = ${placeholders(dialect, 1, i + 1)}`)
    .join(' AND ');
  return `DELETE FROM ${quoteIdent(table.name)} WHERE ${where};`;
}

/** Постраничный список (LIMIT зашит числом — безопасно, не пользовательский ввод). */
export function listSql(table: TableSpec, dialect: SqlDialect, limit = 100, orderBy?: string): string {
  void dialect;
  const pks = pkColumns(table);
  const order =
    orderBy && table.columns.some((c) => c.name === orderBy) ? orderBy : pks[0]?.name;
  const orderClause = order ? `\nORDER BY ${quoteIdent(order)}` : '';
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));
  return (
    `SELECT ${publicSelectList(table)}\n` +
    `FROM ${quoteIdent(table.name)}${orderClause}\nLIMIT ${n};`
  );
}

/** SELECT по произвольной колонке (для индексов: ix_*). */
export function whereEqSql(table: TableSpec, dialect: SqlDialect, column: string): string {
  if (!table.columns.some((c) => c.name === column)) {
    throw new Error(`${table.name}: unknown column ${column}`);
  }
  return (
    `SELECT ${publicSelectList(table)}\n` +
    `FROM ${quoteIdent(table.name)}\n` +
    `WHERE ${quoteIdent(column)} = ${placeholders(dialect, 1)};`
  );
}

/* -------------------------------------------------------------------------- */
/*  3. Реестр DML по всем таблицам                                            */
/* -------------------------------------------------------------------------- */

export interface BindParam {
  index: number;
  column: string;
  type: ColumnSpec['type'];
  /** Параметр уходит в публичную проекцию или это секрет (только write). */
  secret: boolean;
}

export interface TableDml {
  name: string;
  comment: string;
  pk: string[];
  insert: string;
  upsert: string;
  selectByPk: string;
  deleteByPk: string;
  list: string;
  /** Порядок bind-параметров INSERT = insertColumns(). */
  insertParams: BindParam[];
  /** Колонки публичного SELECT (секреты исключены). */
  publicColumns: string[];
  /** Секретные колонки (никогда в публичных проекциях). */
  secretColumns: string[];
}

/** Собрать DML для одной таблицы под выбранный диалект. */
export function buildTableDml(table: TableSpec, dialect: SqlDialect): TableDml {
  const cols = insertColumns(table);
  return {
    name: table.name,
    comment: table.comment,
    pk: pkColumns(table).map((c) => c.name),
    insert: insertSql(table, dialect),
    upsert: upsertSql(table, dialect),
    selectByPk: selectByPkSql(table, dialect),
    deleteByPk: deleteByPkSql(table, dialect),
    list: listSql(table, dialect),
    insertParams: cols.map((c, i) => ({
      index: dialect === 'postgres' ? i + 1 : i,
      column: c.name,
      type: c.type,
      secret: !!c.secret,
    })),
    publicColumns: publicColumns(table).map((c) => c.name),
    secretColumns: table.columns.filter((c) => c.secret).map((c) => c.name),
  };
}

/** Реестр DML по всему `DB_SCHEMA` — контракт для `web/server.js`. */
export function createDmlRegistry(dialect: SqlDialect = 'sqlite'): TableDml[] {
  return DB_SCHEMA.map((t) => buildTableDml(t, dialect));
}

/** Все DML-стейтменты одним текстом (для ревью/копирования в миграции). */
export function createDmlSql(dialect: SqlDialect = 'sqlite'): string {
  const out: string[] = [
    `-- DbSchema DML v${DB_SCHEMA_VERSION} (${dialect}) — generated from DB_SCHEMA`,
  ];
  for (const t of DB_SCHEMA) {
    const dml = buildTableDml(t, dialect);
    out.push('');
    out.push(`-- ${t.name}: ${t.comment}`);
    out.push(`-- pk: ${dml.pk.join(', ') || '∅'} · публичных колонок: ${dml.publicColumns.length}`);
    out.push(dml.upsert);
    out.push(dml.selectByPk);
    out.push(dml.deleteByPk);
  }
  return out.join('\n');
}

/** Сводка DML-слоя для HUD/тестов. */
export function dmlStats(dialect: SqlDialect = 'sqlite') {
  const reg = createDmlRegistry(dialect);
  const statements = reg.length * 5; // insert/upsert/select/delete/list
  const params = reg.reduce((a, t) => a + t.insertParams.length, 0);
  const secrets = reg.reduce((a, t) => a + t.secretColumns.length, 0);
  return { tables: reg.length, statements, params, secrets };
}

/** Одна строка реестра по имени таблицы. */
export function tableDml(name: string, dialect: SqlDialect = 'sqlite'): TableDml | undefined {
  return createDmlRegistry(dialect).find((t) => t.name === name);
}

/* -------------------------------------------------------------------------- */
/*  4. React: 2D-консоль DML (вне <Canvas>, рядом с DbSchemaLive)             */
/* -------------------------------------------------------------------------- */

export interface DbSchemaQueriesProps {
  /** Стартовый диалект. */
  dialect?: SqlDialect;
  /** Колбэк закрытия панели. */
  onClose?: () => void;
}

function paramHint(p: BindParam): string {
  const idx = p.index === 0 ? '?' : `$${p.index}`;
  return `${idx} → ${p.column}:${p.type}${p.secret ? ' 🔒' : ''}`;
}

/** Консоль параметризованного DML: выбираешь таблицу — видишь запросы и бинды. */
export function DbSchemaQueries({ dialect: initial = 'sqlite', onClose }: DbSchemaQueriesProps) {
  const [dialect, setDialect] = useState<SqlDialect>(initial);
  const [selected, setSelected] = useState<string>(DB_SCHEMA[0]?.name ?? '');

  const registry = useMemo(() => createDmlRegistry(dialect), [dialect]);
  const stats = useMemo(() => dmlStats(dialect), [dialect]);
  const problems = useMemo(() => validateSchema(DB_SCHEMA), []);
  const active: TableDml = registry.find((r) => r.name === selected) ?? registry[0];
  const healthy = problems.length === 0;

  if (!active) {
    return (
      <div style={panel} data-testid="db-schema-queries">
        <div style={headerRow}>
          <span style={title}>🧩 DB DML</span>
          {onClose && (
            <button style={closeBtn} onClick={onClose} type="button" aria-label="close">
              ✕
            </button>
          )}
        </div>
        <div style={{ color: '#ef4444', fontSize: 12 }}>Схема пуста.</div>
      </div>
    );
  }

  return (
    <div style={panel} data-testid="db-schema-queries">
      <div style={headerRow}>
        <div>
          <div style={title}>🧩 DB DML · v{DB_SCHEMA_VERSION}</div>
          <div style={{ fontSize: 11, color: healthy ? '#22c55e' : '#ef4444', marginTop: 2 }}>
            {healthy ? '● SCHEMA OK' : `● PROBLEMS: ${problems.length}`}
            {' · '}
            {stats.tables} tables · {stats.statements} stmts · {stats.params} bind ·{' '}
            <span style={{ color: '#f59e0b' }}>{stats.secrets} secret</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button style={tabBtn(dialect === 'sqlite')} onClick={() => setDialect('sqlite')} type="button">
            sqlite
          </button>
          <button style={tabBtn(dialect === 'postgres')} onClick={() => setDialect('postgres')} type="button">
            postgres
          </button>
          {onClose && (
            <button style={closeBtn} onClick={onClose} type="button" aria-label="close">
              ✕
            </button>
          )}
        </div>
      </div>

      <div style={grid}>
        <div>
          <div style={sectionTitle}>TABLES · DML</div>
          <div style={scroll}>
            {registry.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => setSelected(t.name)}
                style={tableBtn(t.name === active.name)}
              >
                <span style={{ fontWeight: 700, color: t.name === active.name ? '#0b1220' : '#38bdf8' }}>
                  {t.name}
                </span>
                <span style={{ fontSize: 10, color: t.name === active.name ? '#0b1220' : '#7a8baa' }}>
                  {' '}PK {t.pk.join('+') || '∅'} · {t.publicColumns.length}p
                  {t.secretColumns.length ? ` · 🔒${t.secretColumns.length}` : ''}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div style={sectionTitle}>UPSERT · {active.name}</div>
          <pre style={pre}>{active.upsert}</pre>

          <div style={sectionTitle}>SELECT BY PK (публичная проекция)</div>
          <pre style={pre}>{active.selectByPk}</pre>

          <div style={sectionTitle}>DELETE BY PK</div>
          <pre style={pre}>{active.deleteByPk}</pre>

          <div style={sectionTitle}>LIST (paginated)</div>
          <pre style={pre}>{active.list}</pre>

          <div style={sectionTitle}>BIND PARAMS · INSERT</div>
          <div style={binds}>
            {active.insertParams.map((p) => (
              <span key={p.column} style={bind(p.secret)}>
                {paramHint(p)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default DbSchemaQueries;

/* -------------------------------------------------------------------------- */
/*  5. Стили (инлайн, без зависимостей)                                       */
/* -------------------------------------------------------------------------- */

const panel: CSSProperties = {
  position: 'absolute',
  top: 80,
  right: 24,
  width: 680,
  maxWidth: '94vw',
  maxHeight: 'calc(100vh - 120px)',
  overflow: 'hidden',
  background: 'rgba(11,18,32,0.97)',
  border: '1px solid #2a1e5f',
  borderRadius: 10,
  padding: 12,
  zIndex: 32,
  pointerEvents: 'auto',
  color: '#e0e6f0',
  boxShadow: '0 10px 40px rgba(0,0,0,0.55)',
};

const headerRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  borderBottom: '1px solid #2a1e5f',
  paddingBottom: 8,
  marginBottom: 8,
};

const title: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#a855f7',
  letterSpacing: 1,
};

const tabBtn = (activeTab: boolean): CSSProperties => ({
  background: activeTab ? '#a855f7' : 'transparent',
  color: activeTab ? '#0b1220' : '#94a3b8',
  border: '1px solid #a855f7',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 700,
  padding: '3px 8px',
  cursor: 'pointer',
});

const closeBtn: CSSProperties = {
  background: 'transparent',
  color: '#94a3b8',
  border: '1px solid #334155',
  borderRadius: 6,
  fontSize: 12,
  padding: '3px 8px',
  cursor: 'pointer',
};

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '0.9fr 1.1fr',
  gap: 12,
};

const sectionTitle: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 1.5,
  color: '#7a8baa',
  margin: '6px 0 4px',
  textTransform: 'uppercase',
};

const scroll: CSSProperties = {
  maxHeight: 'calc(100vh - 190px)',
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  paddingRight: 4,
};

const tableBtn = (activeTab: boolean): CSSProperties => ({
  textAlign: 'left',
  background: activeTab ? '#a855f7' : 'rgba(30,58,95,0.25)',
  border: '1px solid #1e3a5f',
  borderRadius: 6,
  padding: '5px 8px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 11,
});

const pre: CSSProperties = {
  margin: 0,
  marginBottom: 4,
  padding: '6px 8px',
  background: '#060b16',
  border: '1px solid #1e3a5f',
  borderRadius: 6,
  fontSize: 10.5,
  lineHeight: 1.45,
  color: '#9fe0ff',
  whiteSpace: 'pre-wrap',
  overflow: 'auto',
  maxHeight: 110,
};

const binds: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginBottom: 6,
};

const bind = (secret: boolean): CSSProperties => ({
  fontSize: 10,
  fontFamily: 'monospace',
  padding: '2px 6px',
  borderRadius: 5,
  border: `1px solid ${secret ? 'rgba(245,158,11,0.6)' : 'rgba(56,189,248,0.45)'}`,
  color: secret ? '#fbbf24' : '#7dd3fc',
  background: secret ? 'rgba(245,158,11,0.1)' : 'rgba(56,189,248,0.08)',
});
