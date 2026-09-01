defmodule PhoenixApp.Agents.Pipeline do
  @moduledoc """
  Запуск конвейера: план -> сохранение в память.
  """

  alias PhoenixApp.Agents.Planner
  alias PhoenixApp.Agents.MemoryStub, as: Memory

  def run(topic, context) do
    plan = Planner.plan(topic, context)

    Memory.remember(
      "pipeline",
      "short_term",
      "План для темы: #{topic}",
      %{plan: plan, topic: topic}
    )

    {:ok, plan}
  end
end
