defmodule PhoenixAppWeb.CommunityLive do
  use PhoenixAppWeb, :live_view

  @impl true
  def mount(_params, session, socket) do
    locale = session["locale"]
    Gettext.put_locale(PhoenixAppWeb.Gettext, locale || "ru")

    {:ok, socket |> assign(:locale, locale || "ru") |> assign(:entered, false)}
  end
end
