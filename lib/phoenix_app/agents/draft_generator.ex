
defmodule PhoenixApp.Agents.DraftGenerator do
  @moduledoc """
  Генерирует черновик на основе темы и плана шагов.
  """

  @doc """
  Генерирует черновик.

  ## Параметры

    - topic: строка с темой
    - plan: список строк с шагами

  ## Возвращает

    - `{:ok, draft_string}` - кортеж с успешным результатом

  ## Примеры

      iex> PhoenixApp.Agents.DraftGenerator.generate("Написание статьи", ["Выбрать тему", "Составить план", "Написать текст"])
      {:ok, "# Написание статьи\n\n1. Выбрать тему\n2. Составить план\n3. Написать текст"}
  """
  @spec generate(String.t(), [String.t()]) :: {:ok, String.t()}
  def generate(topic, plan) when is_binary(topic) and is_list(plan) do
    draft = build_draft(topic, plan)
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

