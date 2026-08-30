import Config

# Database (SQLite for dev)
config :phoenix_app, PhoenixApp.Repo,
  database: Path.expand("../phoenix_app_dev.db", __DIR__),
  show_sensitive_data_on_connection_error: true,
  log: true,
  pool_size: 10

config :phoenix_app, PhoenixAppWeb.Endpoint,
  http: [ip: {0, 0, 0, 0}, port: 4001],
  check_origin: false,
  code_reloader: true,
  debug_errors: true,
  secret_key_base: "e0eb244b985d3817043ae1c6274a20a3bea37b2cff974b2acc093f024cfe2b05729d08f9240eee6b7f42adfa1b7e1830",
  watchers: []

config :logger, :console, format: "[$level] $message\n"
config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime
