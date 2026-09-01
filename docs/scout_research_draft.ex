
defmodule PhoenixApp.Agents.Scout do
  alias PhoenixApp.Agents.Memory
  alias PhoenixApp.Agents.Scout

  @doc """
  Исследует заданную тему и сохраняет результаты в память агента.

  ## Параметры
    - topic: строка с темой для исследования
    - context: карта с контекстом (может содержать :depth, :max_results и т.д.)

  ## Возвращает
    - {:ok, results} при успешном исследовании
    - {:error, reason} при ошибке
  """
  def research(topic, context \\ %{}) when is_binary(topic) do
    # Получаем текущего агента из процесса (или передаем как параметр)
    scout = self()

    # 1. Ищем релевантные факты
    case fetch_facts(topic, context) do
      {:ok, facts} ->
        # 2. Сохраняем результаты в память
        memory_key = {:research, topic, DateTime.utc_now()}
        
        case Memory.remember(scout, memory_key, %{
          topic: topic,
          facts: facts,
          context: context,
          timestamp: DateTime.utc_now()
        }) do
          {:ok, _} -> {:ok, facts}
          {:error, reason} -> {:error, {:memory_error, reason}}
        end

      {:error, reason} ->
        {:error, {:fetch_error, reason}}
    end
  end

  # Реализация поиска фактов
  defp fetch_facts(topic, context) do
    # Определяем источник данных
    source = Map.get(context, :source, :wikipedia)
    
    case source do
      :wikipedia -> fetch_from_wikipedia(topic, context)
      :mock -> fetch_mock_facts(topic, context)
      :http -> fetch_from_http(topic, context)
      _ -> {:error, :unknown_source}
    end
  end

  # Заглушка для мок-данных
  defp fetch_mock_facts(topic, _context) do
    facts = [
      %{
        title: "Информация о #{topic}",
        summary: "Это заглушка для темы #{topic}. В реальном приложении здесь будут реальные данные.",
        source: "mock",
        relevance: 1.0
      },
      %{
        title: "Дополнительные сведения",
        summary: "Дополнительная информация о #{topic} из мок-источника.",
        source: "mock",
        relevance: 0.8
      }
    ]
    
    {:ok, facts}
  end

  # Реализация через Wikipedia API
  defp fetch_from_wikipedia(topic, context) do
    max_results = Map.get(context, :max_results, 5)
    
    # Формируем URL для Wikipedia API
    url = "https://en.wikipedia.org/w/api.php" <>
          "?action=query" <>
          "&list=search" <>
          "&srsearch=#{URI.encode(topic)}" <>
          "&format=json" <>
          "&srlimit=#{max_results}"

    case HTTPoison.get(url, [], recv_timeout: 10_000) do
      {:ok, %HTTPoison.Response{status_code: 200, body: body}} ->
        case Jason.decode(body) do
          {:ok, %{"query" => %{"search" => results}}} ->
            facts = Enum.map(results, fn result ->
              %{
                title: result["title"],
                summary: result["snippet"] |> String.replace(~r/<[^>]*>/, ""),
                source: "wikipedia",
                relevance: result["wordcount"] / 1000
              }
            end)
            {:ok, facts}
          
          _ -> {:error, :invalid_response}
        end

      {:ok, %HTTPoison.Response{status_code: status}} ->
        {:error, {:http_error, status}}

      {:error, %HTTPoison.Error{reason: reason}} ->
        {:error, {:network_error, reason}}
    end
  end

  # Обобщенная HTTP-реализация
  defp fetch_from_http(topic, context) do
    endpoint = Map.get(context, :endpoint, "https://api.example.com/search")
    
    url = "#{endpoint}?q=#{URI.encode(topic)}"
    
    headers = Map.get(context, :headers, [])
    
    case HTTPoison.get(url, headers, recv_timeout: 10_000) do
      {:ok, %HTTPoison.Response{status_code: 200, body: body}} ->
        case Jason.decode(body) do
          {:ok, data} ->
            # Предполагаем, что API возвращает массив результатов
            facts = case data do
              %{"results" => results} -> results
              %{"data" => results} -> results
              results when is_list(results) -> results
              _ -> []
            end
            
            {:ok, facts}
          
          _ -> {:error, :invalid_json}
        end

      {:ok, %HTTPoison.Response{status_code: status}} ->
        {:error, {:http_error, status}}

      {:error, %HTTPoison.Error{reason: reason}} ->
        {:error, {:network_error, reason}}
    end
  end

  # Вспомогательная функция для получения текущего агента
  defp get_current_agent do
    # Здесь можно реализовать логику получения текущего агента
    # Например, из процесса, конфигурации или параметров
    Process.get(:current_agent) || self()
  end
end


defp deps do
  [
    {:httpoison, "~> 2.0"},
    {:jason, "~> 1.4"}
  ]
end


# Исследование темы с мок-данными
{:ok, facts} = PhoenixApp.Agents.Scout.research("Elixir programming", %{source: :mock})

# Исследование через Wikipedia
{:ok, facts} = PhoenixApp.Agents.Scout.research("Artificial Intelligence", %{
  source: :wikipedia,
  max_results: 3
})

# Исследование с пользовательским HTTP-эндпоинтом
{:ok, facts} = PhoenixApp.Agents.Scout.research("Climate change", %{
  source: :http,
  endpoint
