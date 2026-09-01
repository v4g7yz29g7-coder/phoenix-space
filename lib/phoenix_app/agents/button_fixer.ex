defmodule PhoenixApp.Agents.ButtonFixer do
  @moduledoc """
  Модуль для обработки HTML-разметки, добавляющий заглушку href="#" 
  для всех элементов <a> без атрибута href.
  """

  @doc """
  Принимает HTML-строку и добавляет href="#" для всех элементов <a> без href.

  ## Примеры

      iex> PhoenixApp.Agents.ButtonFixer.add_href("<a>Click</a>")
      "<a href=\"#\">Click</a>"

      iex> PhoenixApp.Agents.ButtonFixer.add_href("<a href=\"/link\">Link</a>")
      "<a href=\"/link\">Link</a>"

      iex> PhoenixApp.Agents.ButtonFixer.add_href("<a class=\"btn\">Button</a>")
      "<a class=\"btn\" href=\"#\">Button</a>"
  """
  @spec add_href(String.t()) :: String.t()
  def add_href(html) when is_binary(html) do
    html
    |> parse_html()
    |> process_nodes()
    |> generate_html()
  end

  # Парсинг HTML с помощью Floki (популярная библиотека для парсинга HTML в Elixir)
  defp parse_html(html) do
    # Используем Floki для парсинга HTML
    {:ok, document} = Floki.parse_document(html)
    document
  end

  # Рекурсивная обработка узлов дерева
  defp process_nodes(nodes) when is_list(nodes) do
    Enum.map(nodes, &process_node/1)
  end

  defp process_node({tag, attrs, children}) when tag in ["a", :a] do
    # Проверяем наличие атрибута href
    if has_href?(attrs) do
      # Если href есть, оставляем как есть
      {tag, attrs, process_nodes(children)}
    else
      # Если href нет, добавляем заглушку
      new_attrs = attrs ++ [{"href", "#"}]
      {tag, new_attrs, process_nodes(children)}
    end
  end

  defp process_node({tag, attrs, children}) do
    # Для остальных тегов просто рекурсивно обрабатываем детей
    {tag, attrs, process_nodes(children)}
  end

  defp process_node(text) when is_binary(text) do
    # Текстовые узлы оставляем без изменений
    text
  end

  # Проверка наличия атрибута href (регистронезависимо)
  defp has_href?(attrs) do
    Enum.any?(attrs, fn {key, _value} ->
      String.downcase(to_string(key)) == "href"
    end)
  end

  # Генерация HTML из обработанного дерева
  defp generate_html(nodes) do
    nodes
    |> Floki.raw_html()
    |> to_string()
  end
end
