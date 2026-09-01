defmodule PhoenixApp.Agents.Reviewer do
  @moduledoc """
  Модуль для проверки и ревью черновиков.
  """

  @min_length 10

  @doc """
  Проверяет черновик на соответствие минимальной длине.

  ## Параметры

    - draft: строка с черновиком
    - context: карта с контекстом (в текущей версии не используется, но оставлен для расширения)

  ## Возвращает

    - `{:ok, draft}` - если длина draft >= 10 символов
    - `{:error, :too_short}` - если длина draft < 10 символов

  ## Примеры

      iex> PhoenixApp.Agents.Reviewer.review("Hello world", %{})
      {:ok, "Hello world"}

      iex> PhoenixApp.Agents.Reviewer.review("Short", %{})
      {:error, :too_short}
  """
  def review(draft, _context) when is_binary(draft) do
    if String.length(draft) >= @min_length do
      {:ok, draft}
    else
      {:error, :too_short}
    end
  end

  # Обработка случая, когда draft не является строкой
  def review(_draft, _context) do
    {:error, :invalid_draft}
  end
end
