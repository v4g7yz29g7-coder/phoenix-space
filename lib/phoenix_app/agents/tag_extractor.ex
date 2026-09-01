defmodule PhoenixApp.Agents.TagExtractor do
  @moduledoc """
  Модуль для извлечения тегов из текста.
  Возвращает список слов длиннее 5 символов, встречающихся чаще одного раза.
  """

  @doc """
  Извлекает теги из текста.

  ## Параметры

    - text: строка с текстом для анализа

  ## Возвращает

  Список уникальных слов длиннее 5 символов, которые встречаются в тексте
  более одного раза.

  ## Примеры

      iex> PhoenixApp.Agents.TagExtractor.extract("hello world hello elixir programming elixir")
      ["hello", "elixir"]

      iex> PhoenixApp.Agents.TagExtractor.extract("short words are not included")
      []
  """
  @spec extract(String.t()) :: [String.t()]
  def extract(text) when is_binary(text) do
    text
    |> String.downcase()
    |> String.split(~r/[^\p{L}\p{N}]+/u, trim: true)
    |> Enum.filter(fn word -> String.length(word) > 5 end)
    |> Enum.frequencies()
    |> Enum.filter(fn {_word, count} -> count > 1 end)
    |> Enum.map(fn {word, _count} -> word end)
    |> Enum.sort()
  end

  def extract(_invalid), do: []
end
