import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/phoenix_app start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :phoenix_app, PhoenixAppWeb.Endpoint, ip: {0, 0, 0, 0}, server : true
end

if config_env() == :dev do
  config :phoenix_app, PhoenixAppWeb.Endpoint,
    http: [port: 4000]
else
  config :phoenix_app, PhoenixAppWeb.Endpoint,
    http: [port: String.to_integer(System.get_env("PORT", "4000"))]
end

if config_env() == :dev do
  # Reload browser tabs when matching files change.
  config :phoenix_app, PhoenixAppWeb.Endpoint,
    live_reload: [
      web_console_logger: true,
      patterns: [
        # Static assets, except user uploads
        ~r"priv/static/(?!uploads/).*\.(js|css|png|jpeg|jpg|gif|svg)$",
        # Gettext translations
        ~r"priv/gettext/.*\.po$",
        # Router, Controllers, LiveViews and LiveComponents
        ~r"lib/phoenix_app_web/router\.ex$",
        ~r"lib/phoenix_app_web/(controllers|live|components)/.*\.(ex|heex)$"
      ]
    ]
end

if config_env() == :prod do
  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"

  config :phoenix_app, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :phoenix_app, PhoenixAppWeb.Endpoint,
    url: [host: host, port: String.to_integer(System.get_env("PORT", "4000")), scheme: "http"],
    http: [
      ip: {0, 0, 0, 0, 0, 0, 0, 0},
      port: String.to_integer(System.get_env("PORT", "4000"))
    ],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :phoenix_app, PhoenixAppWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://plug.hexdocs.pm/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :phoenix_app, PhoenixAppWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.
end

# --- Ecto / SQLite для прод 
# Путь к БД берём из переменной окружения DATABASE_PATH
if config_env() == :prod do
  database_path =
    System.get_env("DATABASE_PATH") ||
      Path.expand("phoenix_app_prod.db")

  config :phoenix_app, PhoenixApp.Repo,
    database: database_path,
    pool_size: String.to_integer(System.get_env("DB_POOL_SIZE", "10"))
end
