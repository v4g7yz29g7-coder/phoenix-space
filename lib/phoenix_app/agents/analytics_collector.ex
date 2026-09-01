defmodule PhoenixApp.Agents.AnalyticsCollector do
  @moduledoc """
  Модуль для сбора аналитики по тексту.
  Подсчитывает количество символов и слов в переданном тексте.
  """

  @doc """
  Принимает текст и возвращает карту с количеством символов и слов.

  ## Примеры

      iex> PhoenixApp.Agents.AnalyticsCollector.collect("Hello world")
      %{chars: 11, words: 2}

      iex> PhoenixApp.Agents.AnalyticsCollector.collect("")
      %{chars: 0, words: 0}

      iex> PhoenixApp.Agents.AnalyticsCollector.collect("  Multiple   spaces  here  ")
      %{chars: 27, words: 3}
  """
  @spec collect(String.t()) :: %{chars: non_neg_integer(), words: non_neg_integer()}
  def collect(text) when is_binary(text) do
    %{
      chars: String.length(text),
      words: count_words(text)
    }
  end

  # Обработка не-строковых аргументов
  def collect(_invalid), do: %{chars: 0, words: 0}

  # Приватная функция для подсчёта слов
  defp count_words(text) do
    text
    |> String.trim()
    |> String.split(~r/\s+/, trim: true)
    |> length()
  end
end
