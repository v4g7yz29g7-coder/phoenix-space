defmodule PhoenixApp.Agents.Formatter do
  @moduledoc """
  Модуль для форматирования текста в различные форматы.
  """

  @doc """
  Преобразует строку в Markdown формат.

  ## Примеры

      iex> PhoenixApp.Agents.Formatter.to_markdown("Hello")
      "Hello"

  """
  @spec to_markdown(String.t()) :: String.t()
  def to_markdown(text) when is_binary(text) do
    # TODO: Реализовать преобразование в Markdown
    text
  end

  @doc """
  Преобразует строку в обычный текст (plain text).

  ## Примеры

      iex> PhoenixApp.Agents.Formatter.to_plain_text("Hello")
      "Hello"

  """
  @spec to_plain_text(String.t()) :: String.t()
  def to_plain_text(text) when is_binary(text) do
    # TODO: Реализовать преобразование в plain text
    text
  end
end
