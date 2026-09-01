defmodule PhoenixApp.Agents.TaskRunner do
  @moduledoc """
  Автономный исполнитель задач.

  Читает задачи из файла и для каждой вызывает bash-агента coder.sh,
  который обращается к DeepSeek и сохраняет результат.
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

  defp call_coder(task) do
    # Вызываем bash-агента coder.sh
    case System.cmd("bash", [Path.expand("~/agents/agents/coder.sh"), task], stderr_to_stdout: true) do
      {output, 0} -> String.trim(output)
      {output, _} -> "Ошибка: " <> String.trim(output)
    end
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
