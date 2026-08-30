defmodule PhoenixApp.Search.Hybrid do
  @moduledoc """
  Гибридный семантический поиск по смыслу.
  """
  alias PhoenixApp.Academy.Sutra
  alias PhoenixApp.Repo
  import Ecto.Query
  @noise_words [
    "купить", "скидка", "реклама", "промокод", "магазин", "продажа",
    "buy", "discount", "advertisement", "shop", "purchase",
    "comprar", "tienda", "venta",
    "acheter", "boutique", "vente",
    "kaufen", "laden", "verkauf",
    "买", "商店", "折扣",
    "شراء", "متجر", "خصم"
  ]
  def search(query, _opts \\ []) do
    query = String.trim(query || "")
    if query == "" do
      %{results: [], query: query}
    else
      local = search_local(query)
      web = search_web(query)
      filtered_web = filter_noise(web)
      results = local ++ filtered_web
      %{results: results, query: query}
    end
  end
  # =========================================================
  # Локальный поиск по базе «Смыслов»
  # =========================================================
  def search_local(query) do
    q = "%" <> String.downcase(query) <> "%"
    results =
      Repo.all(
        from s in Sutra,
          where: ilike(s.title, ^q) or ilike(s.text, ^q),
          order_by: [asc: :order],
          limit: 5
      )
    Enum.map(results, fn s ->
      %{
        title: s.title,
        snippet: truncate_text(s.text, 120),
        url: "/poznanie",
        category: s.category,
        icon: s.icon,
        color: s.color,
        source: :local,
        score: relevance(query, s.title <> " " <> s.text)
      }
    end)
  end
  # =========================================================
  # Интернет-поиск (через :httpc)
  # =========================================================
  def search_web(query) do
    ddg = search_duckduckgo(query)
    wiki = search_wikipedia(query)
    ddg ++ wiki
  rescue
    _ -> []
  end
  defp search_duckduckgo(query) do
    q = URI.encode_www_form(query)
    url = "https://api.duckduckgo.com/?q=#{q}&format=json&no_html=1"
    case http_get(url) do
      {:ok, body} ->
        case Jason.decode(body) do
          {:ok, data} -> parse_ddg(data)
          _ -> []
        end
      _ ->
        []
    end
  end
  defp parse_ddg(body) do
    related = Map.get(body, "RelatedTopics", [])
    if is_list(related) do
      Enum.flat_map(related, fn topic ->
        if is_map(topic) && Map.has_key?(topic, "Text") do
          [
            %{
              title: Map.get(topic, "FirstURL", "") |> to_string() |> String.replace(~r{https?://}, ""),
              snippet: Map.get(topic, "Text", ""),
              url: Map.get(topic, "FirstURL", ""),
              source: :web,
              score: 0.5
            }
          ]
        else
          []
        end
      end)
    else
      []
    end
  end
  defp search_wikipedia(query) do
    q = URI.encode_www_form(query)
    url = "https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=#{q}&format=json&srlimit=5"
    case http_get(url) do
      {:ok, body} ->
        case Jason.decode(body) do
          {:ok, data} ->
            case Map.get(data, "query") do
              %{"search" => results} when is_list(results) ->
                Enum.map(results, fn r ->
                  title = Map.get(r, "title", "")
                  snippet = strip_html(Map.get(r, "snippet", ""))
                  %{
                    title: title,
                    snippet: snippet,
                    url: "https://ru.wikipedia.org/wiki/" <> URI.encode_www_form(title),
                    source: :web,
                    score: 0.4
                  }
                end)
              _ ->
                []
            end
          _ ->
            []
        end
      _ ->
        []
    end
  end
  defp http_get(url) do
    # Используем встроенный HTTP-клиент Erlang
    :inets.start()
    :ssl.start()
    case :httpc.request(:get, {to_charlist(url), []}, [timeout: 5000], [body_format: :binary]) do
      {:ok, {{_version, 200, _reason}, _headers, body}} ->
        {:ok, body}
      {:ok, {{_version, status, _reason}, _headers, body}} when status in [301, 302, 303] ->
        # Следуем редиректам
        {:error, :redirect}
      other ->
        {:error, other}
    end
  rescue
    _ -> {:error, :http_error}
  end
  defp strip_html(text) do
    text
    |> to_string()
    |> String.replace(~r/<[^>]+>/, "")
    |> String.replace("&quot;", "\"")
    |> String.replace("&#039;", "'")
    |> String.replace("&amp;", "&")
  end
  # =========================================================
  # Смысловая фильтрация
  # =========================================================
  def filter_noise(results) do
    results
    |> Enum.filter(fn r ->
      title = String.downcase(r.title || "")
      snippet = String.downcase(r.snippet || "")
      not Enum.any?(@noise_words, fn word ->
        String.contains?(title, word) or String.contains?(snippet, word)
      end)
    end)
    |> Enum.take(8)
  end
  # =========================================================
  # Оценка релевантности
  # =========================================================
  def relevance(query, text) do
    q_words = tokenize(query)
    t_text = String.downcase(text || "")
    if q_words == [] do
      0.5
    else
      matching =
        Enum.count(q_words, fn w ->
          String.contains?(t_text, String.downcase(w))
        end)
      base = matching / length(q_words)
      semantic_depth = [
        "смысл", "познание", "мудрость", "глубина", "дух",
        "meaning", "wisdom", "depth", "spirit",
        "significado", "sabiduría", "profundidad",
        "sens", "sagesse", "profondeur",
        "Bedeutung", "Weisheit", "Tiefe"
      ]
      boost =
        Enum.count(semantic_depth, fn kw ->
          String.contains?(t_text, String.downcase(kw))
        end)
      min(base + boost * 0.1, 1.0)
    end
  end
  defp tokenize(text) do
    String.downcase(text || "")
    |> String.split(~r/[^\\p{L}0-9]+/u, trim: true)
    |> Enum.filter(fn w -> String.length(w) > 1 end)
  end
  defp truncate_text(text, limit) do
    if String.length(text || "") <= limit do
      text || ""
    else
      String.slice(text || "", 0, limit) <> "..."
    end
  end
end
