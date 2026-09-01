defmodule PhoenixApp.Agents.TaskRunner do
  @moduledoc """
  Автономный исполнитель задач.

  Читает задачи из файла, для каждой вызывает DeepSeek через llm_call.py,
  извлекает код Elixir из ответа и сохраняет его в /home/ishidin/phoenix_app/lib/phoenix_app/agents/generated/.
  Результаты также пишутся в память (MemoryStub).
  """

  alias PhoenixApp.Agents.MemoryStub, as: Memory

  @tasks_file Path.expand("tasks.txt", System.user_home!())
  @generated_dir "/home/ishidin/phoenix_app/lib/phoenix_app/agents/generated"

  def run do
    tasks = read_tasks()
    Enum.each(tasks, &execute_task/1)
    :ok
  end

  defp execute_task(task) do
    IO.puts("▶ Задача: #{task}")

    result = call_deepseek(task)
    code = extract_elixir_code(result)

    if code != "" do
      save_generated_code(task, code)
      IO.puts("  Сохранён код")
    end

    Memory.remember(
      "task_runner",
      "short_term",
      "Выполнена задача: #{task}",
      %{task: task, result: result}
    )

    IO.puts("✓ Завершено\n")
  end

  defp call_deepseek(task) do
    case System.cmd("python3", [Path.expand("~/agents/llm_call.py"), task], stderr_to_stdout: true) do
      {output, 0} -> String.trim(output)
      {output, _} -> "Ошибка: " <> String.trim(output)
    end
  end

  defp extract_elixir_code(response) do
    case Regex.run(~r/```elixir\n(.*?)```/s, response) do
      [_, code] -> code
      _ -> ""
    end
  end

  defp save_generated_code(task, code) do
    File.mkdir_p!(@generated_dir)
    timestamp = DateTime.utc_now() |> DateTime.to_unix()
    filename = "task_#{timestamp}.ex"
    File.write!(Path.join(@generated_dir, filename), code)
    IO.puts("  Файл: #{filename}")
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
