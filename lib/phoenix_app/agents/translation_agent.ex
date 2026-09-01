defmodule PhoenixApp.Agents.TranslationAgent do
  @moduledoc """
  Агент для перевода текста.
  
  В текущей версии является заглушкой и возвращает исходный текст без изменений.
  В будущем здесь будет реализована интеграция с внешними API перевода.
  """

  @doc """
  Переводит текст на указанный язык.

  ## Параметры

    - text: строка с текстом для перевода
    - language: строка с кодом языка (например, "en", "ru", "es")

  ## Возвращает

    Строку с переведённым текстом. В текущей версии возвращает исходный текст.

  ## Примеры

      iex> PhoenixApp.Agents.TranslationAgent.translate("Hello world", "ru")
      "Hello world"

      iex> PhoenixApp.Agents.TranslationAgent.translate("Привет мир", "en")
      "Привет мир"
  """
  @spec translate(String.t(), String.t()) :: String.t()
  def translate(text, _language) when is_binary(text) do
    # Заглушка: возвращаем исходный текст без изменений
    text
  end

  def translate(_text, _language) do
    raise ArgumentError, "text должен быть строкой"
  end
end
