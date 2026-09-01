defmodule PhoenixApp.Agents.ModerationAgent do
  @moduledoc """
  Модуль для модерации текста на наличие запрещённых слов.
  """

  # Список запрещённых слов (можно расширить)
  @bad_words [
    "плохое_слово1",
    "плохое_слово2",
    "мат1",
    "мат2",
    "оскорбление",
    "нецензурное"
  ]

  @doc """
  Проверяет текст на наличие запрещённых слов.

  ## Примеры

      iex> PhoenixApp.Agents.ModerationAgent.check("Это нормальный текст")
      :ok

      iex> PhoenixApp.Agents.ModerationAgent.check("Здесь есть плохое_слово1")
      {:error, :bad_words}

  """
  @spec check(String.t()) :: :ok | {:error, :bad_words}
  def check(text) when is_binary(text) do
    normalized_text = text |> String.downcase() |> String.trim()

    if contains_bad_words?(normalized_text) do
      {:error, :bad_words}
    else
      :ok
    end
  end

  def check(_invalid_input), do: {:error, :bad_words}

  # Приватная функция для проверки наличия запрещённых слов
  defp contains_bad_words?(text) do
    Enum.any?(@bad_words, fn bad_word ->
      String.contains?(text, bad_word)
    end)
  end
end
