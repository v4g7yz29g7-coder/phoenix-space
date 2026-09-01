defmodule PhoenixAppWeb.HomeLive do
  use PhoenixAppWeb, :live_view

  alias PhoenixApp.Search.Hybrid

  @impl true
  def mount(_params, session, socket) do
    IO.inspect(session, label: "SESSION IN MOUNT")
    locale = session["locale"]
    Gettext.put_locale(PhoenixAppWeb.Gettext, locale || "ru")

    {:ok,
     socket
     |> assign(:locale, locale || "ru")
     |> assign(:query, "")
     |> assign(:results, [])
     |> assign(:searching, false)
     |> assign(:searched, false)}
  end

  @impl true
  def handle_event("search", %{"query" => query}, socket) do
    query = String.trim(query || "")

    if query == "" do
      {:noreply, socket |> assign(:results, []) |> assign(:searched, false) |> assign(:query, "")}
    else
      results = Hybrid.search(query)
      results = results.results

      {:noreply,
       socket
       |> assign(:query, query)
       |> assign(:results, results)
       |> assign(:searched, true)}
    end
  end

  def handle_event("clear_search", _params, socket) do
    {:noreply,
     socket
     |> assign(:query, "")
     |> assign(:results, [])
     |> assign(:searched, false)}
  end

  # Помощник для шаблона: возвращает один из двух значений
  def if_else(cond, when_true, when_false) do
    if cond, do: when_true, else: when_false
  end
end
