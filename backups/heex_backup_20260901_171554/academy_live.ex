defmodule PhoenixAppWeb.AcademyLive do
  use PhoenixAppWeb, :live_view

  alias PhoenixApp.Academy

  @impl true
  def mount(_params, session, socket) do
    sutras = Academy.list_sutras()
    practices = Academy.list_practices()

    locale = session["locale"]
    Gettext.put_locale(PhoenixAppWeb.Gettext, locale || "ru")

    socket =
      socket
      |> assign(:locale, locale || "ru")
      |> assign(:sutras, sutras)
      |> assign(:practices, practices)
      |> assign(:active_tab, "sutra")
      |> assign(:items, sutras)
      |> assign(:expanded_id, nil)
      |> assign(:entered, false)

    {:ok, socket}
  end

  @impl true
  def handle_event("select_tab", %{"tab" => tab}, socket) do
    items =
      case tab do
        "practice" -> socket.assigns.practices
        _ -> socket.assigns.sutras
      end

    {:noreply,
     socket
     |> assign(:active_tab, tab)
     |> assign(:items, items)
     |> assign(:expanded_id, nil)
     |> assign(:entered, false)}
  end

  @impl true
  def handle_event("toggle_expand", %{"id" => id}, socket) do
    expanded_id =
      if socket.assigns.expanded_id == id, do: nil, else: id

    {:noreply,
     socket
     |> assign(:expanded_id, expanded_id)
     |> assign(:entered, expanded_id != nil)}
  end

  @impl true
  def handle_event("close", _params, socket) do
    {:noreply, socket |> assign(:expanded_id, nil) |> assign(:entered, false)}
  end
end
