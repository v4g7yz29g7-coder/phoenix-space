defmodule PhoenixApp.Agents.TaskRunner do
  @moduledoc """
  Автономный исполнитель задач.

  Читает задачи из файла (по одной на строку) и выполняет их через Coder.
  Результаты сохраняются в память (MemoryStub).
  """

  alias PhoenixApp.Agents.MemoryStub, as: Memory

  @tasks_file Path.expand("tasks.txt", System.user_home!())

  def run do
    tasks = read_tasks()
    Enum.each(tasks, &execute_task/1)
    :ok
  end

  defp execute_task(task) do
    IO.puts("▶ Задача: #{task}")

    result = call_coder(task)

    Memory.remember(
      "task_runner",
      "short_term",
      "Выполнена задача: #{task}",
      %{task: task, result: result}
    )

    IO.puts("✓ Завершено\n")
  end

  # Заглушка: здесь будет вызов DeepSeek через HTTP или shell-агента
  defp call_coder(task) do
    # В будущем: вызов ~/agents/agents/coder.sh или прямого API
    "Черновик для: #{task}"
  end

  defp read_tasks do
    case File.read(@tasks_file) do
      {:ok, content} ->
        content
        |> String.split("\n")
        |> Enum.map(&String.trim/1)
        |> Enum.reject(&(&1 == ""))

      _ -> []
    end
  end
end
