
defmodule PhoenixApp.Agents.Pipeline do
  @moduledoc """
  Модуль для запуска конвейера агентов.
  """

  @doc """
  Запускает конвейер: вызывает планировщик и возвращает план.

  ## Параметры

    - topic: тема для планирования
    - context: контекст для планирования

  ## Возвращает

    - `{:ok, plan}` при успешном планировании
  """
  @spec run(any(), any()) :: {:ok, any()}
  def run(topic, context) do
    plan = PhoenixApp.Agents.Planner.plan(topic, context)
    {:ok, plan}
  end
end

