defmodule PhoenixApp.Agents.DraftGenerator do
  @moduledoc """
  Генерация черновика и сохранение в память.
  """

  alias PhoenixApp.Agents.MemoryStub, as: Memory

  def generate(topic, plan) when is_binary(topic) and is_list(plan) do
    draft = build_draft(topic, plan)

    Memory.remember(
      "draft_generator",
      "short_term",
      "Черновик для темы: #{topic}",
      %{draft: draft, topic: topic}
    )

    {:ok, draft}
  end

  defp build_draft(topic, plan) do
    header = "# #{topic}\n\n"
    steps = plan
            |> Enum.with_index(1)
            |> Enum.map(fn {step, index} -> "#{index}. #{step}" end)
            |> Enum.join("\n")

    header <> steps
  end
end
