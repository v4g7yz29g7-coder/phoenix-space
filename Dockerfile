# ============================================================
#  ЭТАП 1: BUILDER
# ============================================================
FROM hexpm/elixir:1.18.3-erlang-27.2.3-alpine-3.21.3 AS builder

ENV MIX_ENV=prod

# Установка build-зависимостей (нужны для компиляции некоторых deps)
RUN apk add --no-cache --update git build-base

WORKDIR /app

# Копируем манифесты зависимостей и проект
COPY mix.exs mix.lock ./
COPY config ./config
COPY lib ./lib
COPY priv ./priv

# Устанавливаем hex и rebar
RUN mix archive.install github hexpm/hex branch latest --force && \
    mix deps.get --only prod && \
    mix deps.compile

# Компиляция ассетов (статики) и приложения
RUN mix phx.digest && \
    mix compile

# ============================================================
#  ЭТАП 2: RELEASE
# ============================================================
RUN MIX_ENV=prod mix release

# ============================================================
#  ЭТАП 3: RUN (финальный образ)
# ============================================================
FROM hexpm/elixir:1.18.3-erlang-27.2.3-alpine-3.21.3

# Устанавливаем runtime зависимость (нужно для Erlang crypto)
RUN apk add --no-cache libstdc++ ncurses-libs openssl

WORKDIR /app

# Копируем собранный release из builder
COPY --from=builder /app/_build/prod/rel/phoenix_app ./

# Копируем priv для миграций и сидов
COPY --from=builder /app/priv ./priv

# Переменные окружения
ENV MIX_ENV=prod \
    PORT=4000 \
    PHX_HOST=localhost \
    SECRET_KEY_BASE=""

EXPOSE 4000

# Миграции и сиды из /app/priv/repo/migrations и /app/priv/repo/seeds.exs
CMD ["sh", "-c", "    bin/phoenix_app eval 'Application.ensure_all_started(:phoenix_app); Ecto.Migrator.run(PhoenixApp.Repo, \"/app/priv/repo/migrations\", :up, all: true)' &&     bin/phoenix_app eval 'Application.ensure_all_started(:phoenix_app); Code.require_file(\"/app/priv/repo/seeds.exs\")' &&     bin/phoenix_app start"]
