defmodule PhoenixApp.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      PhoenixAppWeb.Telemetry,
      PhoenixApp.Repo,
      {DNSCluster, query: Application.get_env(:phoenix_app, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: PhoenixApp.PubSub},
      PhoenixAppWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: PhoenixApp.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    PhoenixAppWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
