defmodule PhoenixAppWeb.CommunityDetailLive do
  use PhoenixAppWeb, :live_view

  @impl true
  def mount(%{"slug" => slug}, session, socket) do
    locale = session["locale"]

    details = %{
      "common-circle" => %{
        title_key: "Общий круг",
        icon: "flower-of-life.svg",
        color: "#0EA5E9",
        description_key: "Пространство соединения душ, где каждый смысл обогащается в диалоге с другими.",
        full_text: "Пространство соединения душ — где каждый смысл обогащается в диалоге с другими. Здесь мы собираемся вместе, чтобы делиться открытиями, обсуждать глубинные вопросы и поддерживать друг друга на пути. Общий круг — это место встречи и обмена энергиями, где каждый голос имеет значение."
      },
      "path-together" => %{
        title_key: "Путь вместе",
        icon: "pyramid.svg",
        color: "#10B981",
        description_key: "Совместная практика и взаимная поддержка на пути к постижению глубины.",
        full_text: "Совместная практика и взаимная поддержка на пути к постижению глубины. Мы идём не в одиночку — каждый шаг укрепляется множеством шагов. Путь вместе — это взаимное усилие, общие ритмы практики и поддержка, которая помогает преодолевать любые препятствия."
      },
      "living-dialogue" => %{
        title_key: "Живой диалог",
        icon: "ankh.svg",
        color: "#F59E0B",
        description_key: "Пространство открытого обмена — где слова становятся мостами между сердцами.",
        full_text: "Пространство открытого обмена — где слова становятся мостами между сердцами. Живой диалог — это не просто разговор, это способ постижения истины вместе. Здесь мы слушаем друг друга, задаём вопросы и позволяем разговору вести нас к новым горизонтам понимания."
      }
    }

    case Map.get(details, slug) do
      nil ->
        {:ok, socket |> assign(:not_found, true) |> assign(:locale, locale || "ru")}

      info ->
        {:ok,
         socket
         |> assign(:not_found, false)
         |> assign(:slug, slug)
         |> assign(:title_key, info.title_key)
         |> assign(:icon, info.icon)
         |> assign(:color, info.color)
         |> assign(:description_key, info.description_key)
         |> assign(:full_text, info.full_text)
         |> assign(:locale, locale || "ru")}
    end
  end
end
