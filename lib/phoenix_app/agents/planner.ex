defmodule PhoenixApp.Agents.Planner do
  @moduledoc """
  Модуль для планирования шагов создания контента.
  """

  @spec plan(String.t(), map()) :: list(atom())
  def plan(topic, context) when is_binary(topic) and is_map(context) do
    topic
    |> validate_topic()
    |> build_base_steps()
    |> add_context_steps(context)
    |> add_quality_steps(context)
    |> finalize_steps()
  end

  defp validate_topic(topic) when byte_size(topic) < 3 do
    raise ArgumentError, "Тема слишком короткая"
  end
  defp validate_topic(topic), do: topic

  defp build_base_steps(_topic), do: [:research, :draft, :review, :publish]

  defp add_context_steps(steps, context) do
    steps
    |> maybe_add_research_depth(context)
    |> maybe_add_visual_steps(context)
    |> maybe_add_seo_steps(context)
  end

  defp maybe_add_research_depth(steps, %{research_depth: :deep}) do
    List.insert_at(steps, 1, :deep_research)
  end
  defp maybe_add_research_depth(steps, _context), do: steps

  defp maybe_add_visual_steps(steps, %{visuals: true}) do
    steps
    |> List.insert_at(2, :create_visuals)
    |> List.insert_at(3, :optimize_visuals)
  end
  defp maybe_add_visual_steps(steps, _context), do: steps

  defp maybe_add_seo_steps(steps, %{seo: true}) do
    steps
    |> List.insert_at(4, :seo_optimization)
    |> List.insert_at(5, :meta_description)
  end
  defp maybe_add_seo_steps(steps, _context), do: steps

  defp add_quality_steps(steps, %{quality: :high}) do
    steps
    |> List.insert_at(3, :fact_check)
    |> List.insert_at(4, :editorial_review)
  end
  defp add_quality_steps(steps, _context), do: steps

  defp finalize_steps(steps) do
    steps
    |> Enum.uniq()
    |> ensure_publish_last()
  end

  defp ensure_publish_last(steps) do
    if :publish in steps do
      (steps -- [:publish]) ++ [:publish]
    else
      steps
    end
  end

  @spec step_description(atom()) :: String.t()
  def step_description(:research), do: "Исследование темы"
  def step_description(:deep_research), do: "Глубокое исследование"
  def step_description(:draft), do: "Создание черновика"
  def step_description(:create_visuals), do: "Создание визуальных материалов"
  def step_description(:optimize_visuals), do: "Оптимизация визуальных материалов"
  def step_description(:review), do: "Рецензирование"
  def step_description(:fact_check), do: "Проверка фактов"
  def step_description(:editorial_review), do: "Редакторская проверка"
  def step_description(:seo_optimization), do: "SEO-оптимизация"
  def step_description(:meta_description), do: "Создание мета-описания"
  def step_description(:publish), do: "Публикация"
  def step_description(_), do: "Неизвестный шаг"
end
