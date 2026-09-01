defmodule PhoenixApp.Agents.ContentClassifier do
  @moduledoc """
  Модуль для классификации контента на основе длины текста.
  """

  @doc """
  Классифицирует текст на основе его длины.

  Возвращает:
  - `:podcast` - для коротких текстов (менее 100 символов)
  - `:post` - для средних текстов (от 100 до 1000 символов)
  - `:article` - для длинных текстов (более 1000 символов)

  ## Примеры

      iex> PhoenixApp.Agents.ContentClassifier.classify("Короткий текст")
      :podcast

      iex> PhoenixApp.Agents.ContentClassifier.classify(String.duplicate("a", 500))
      :post

      iex> PhoenixApp.Agents.ContentClassifier.classify(String.duplicate("a", 1500))
      :article
  """
  @spec classify(String.t()) :: :article | :post | :podcast
  def classify(text) when is_binary(text) do
    length = String.length(text)

    cond do
      length < 100 -> :podcast
      length <= 1000 -> :post
      true -> :article
    end
  end

  # Обработка невалидных аргументов
  def classify(_invalid), do: raise(ArgumentError, "Текст должен быть строкой")
end
