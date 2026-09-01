defmodule PhoenixApp.Agents.FrontendFixer do
  @moduledoc """
  Модуль для исправления мобильной версии HTML-контента.
  Заменяет фиксированную ширину на максимальную ширину для адаптивности.
  """

  @doc """
  Принимает HTML-строку и заменяет все `width: <число>px` на `max-width: <число>px`.

  ## Примеры

      iex> PhoenixApp.Agents.FrontendFixer.fix_mobile("<div style=\"width: 300px\">Hello</div>")
      "<div style=\"max-width: 300px\">Hello</div>"

      iex> PhoenixApp.Agents.FrontendFixer.fix_mobile("<div style=\"width: 100px; height: 50px\">Test</div>")
      "<div style=\"max-width: 100px; height: 50px\">Test</div>"
  """
  @spec fix_mobile(String.t()) :: String.t()
  def fix_mobile(html) when is_binary(html) do
    html
    |> replace_width_with_max_width()
  end

  def fix_mobile(_invalid_input), do: ""

  # Приватная функция для замены width на max-width
  defp replace_width_with_max_width(html) do
    # Регулярное выражение для поиска width: <число>px
    # Учитываем возможные пробелы и регистр
    regex = ~r/width\s*:\s*(\d+(?:\.\d+)?)px/i

    # Заменяем все вхождения
    Regex.replace(regex, html, fn match, number ->
      # Проверяем, не является ли это уже max-width
      if String.contains?(match, "max-width") do
        match
      else
        "max-width: #{number}px"
      end
    end)
  end
end
