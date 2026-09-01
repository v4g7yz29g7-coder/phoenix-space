defmodule PhoenixApp.Agents.ContentCleaner do
  @moduledoc """
  Модуль для очистки контента от placeholder-текстов.
  """

  @doc """
  Заменяет все вхождения "Lorem ipsum" на "Контент скоро появится".

  ## Примеры

      iex> PhoenixApp.Agents.ContentCleaner.replace_placeholders("Lorem ipsum dolor sit amet")
      "Контент скоро появится dolor sit amet"

      iex> PhoenixApp.Agents.ContentCleaner.replace_placeholders("Текст с Lorem ipsum и ещё Lorem ipsum")
      "Текст с Контент скоро появится и ещё Контент скоро появится"

      iex> PhoenixApp.Agents.ContentCleaner.replace_placeholders("Без placeholder")
      "Без placeholder"
  """
  @spec replace_placeholders(String.t()) :: String.t()
  def replace_placeholders(text) when is_binary(text) do
    String.replace(text, "Lorem ipsum", "Контент скоро появится")
  end

  def replace_placeholders(_invalid_input) do
    raise ArgumentError, "Ожидается строка (binary), получено: #{inspect(_invalid_input)}"
  end
end
