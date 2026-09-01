defmodule PhoenixApp.Agents.Coder do
  use GenServer
  alias PhoenixApp.Agents.Memory

  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def init(state) do
    Process.send_after(self(), :process_scout_tasks, 3000)
    {:ok, state}
  end

  def handle_info(:process_scout_tasks, state) do
    tasks = Memory.recall(:scout, :short_term, 20)

    Enum.each(tasks, fn task ->
      file = task.metadata[:file]

      if file && File.exists?(file) do
        content = File.read!(file)
        new_content = remove_io_inspect_lines(content)

        if new_content != content do
          File.write!(file, new_content)
          Memory.remember(:coder, :short_term, "Исправлено: #{task.content}", %{task: task})
        end
      end
    end)

    Process.send_after(self(), :process_scout_tasks, 60 * 1000)
    {:noreply, state}
  end

  defp remove_io_inspect_lines(content) do
    content
    |> String.split("\n")
    |> Enum.reject(&String.contains?(&1, "IO.inspect"))
    |> Enum.join("\n")
  end
end
