defmodule PhoenixAppWeb.Router do
  use PhoenixAppWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {PhoenixAppWeb.Layouts, :root}
    plug :put_locale
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  # Устанавливаем локаль из сессии
  @doc false
  def put_locale(conn, _opts) do
    locale = get_session(conn, :locale)
    assign(conn, :locale, locale || "ru")
  end

  scope "/", PhoenixAppWeb do
    pipe_through :browser

    live "/", HomeLive
    get "/set_locale/:locale", PageController, :set_locale

    live "/poznanie", AcademyLive
    live "/soobshestvo", CommunityLive
    live "/soobshestvo/:slug", CommunityDetailLive
  end

  if Application.compile_env(:phoenix_app, :dev_routes) do
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through :browser

      live_dashboard "/dashboard", metrics: PhoenixAppWeb.Telemetry
      forward "/mailbox", Plug.Swoosh.MailboxPreview
    end
  end
end
