defmodule PhoenixApp.Agents.SummaryGenerator do
  @moduledoc """
  Модуль для генерации краткого резюме текста.
  Возвращает первые 50 символов с многоточием.
  """

  @doc """
  Генерирует краткое резюме текста.

  ## Параметры

    - text: строка с текстом для резюмирования

  ## Возвращает

    Строку с первыми 50 символами текста и многоточием.

  ## Примеры

      iex> PhoenixApp.Agents.SummaryGenerator.generate("Это очень длинный текст, который нужно сократить")
      "Это очень длинный текст, который нужно сократить..."

      iex> PhoenixApp.Agents.SummaryGenerator.generate("Короткий текст")
      "Короткий текст..."

      iex> PhoenixApp.Agents.SummaryGenerator.generate("")
      "..."
  """
  @spec generate(String.t()) :: String.t()
  def generate(text) when is_binary(text) do
    text
    |> String.slice(0, 50)
    |> Kernel.<>("...")
  end

  def generate(_), do: "..."
end
