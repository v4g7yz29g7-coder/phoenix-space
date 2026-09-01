defmodule PhoenixApp.Agents.Scout do
  use GenServer

  alias PhoenixApp.Agents.Memory

  # Client API

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  # Server callbacks

  @impl true
  def init(state) do
    # Schedule first scan
    Process.send_after(self(), :scan, 0)
    {:ok, state}
  end

  @impl true
  def handle_info(:scan, state) do
    scan_files()
    # Schedule next scan in 30 minutes
    Process.send_after(self(), :scan, 30 * 60 * 1000)
    {:noreply, state}
  end

  defp scan_files do
    files = Path.wildcard("lib/**/*.ex")

    Enum.each(files, fn file ->
      case File.read(file) do
        {:ok, content} ->
          lines = String.split(content, "\n")

          Enum.with_index(lines, 1)
          |> Enum.each(fn {line, line_no} ->
            if String.contains?(line, "IO.inspect") or String.contains?(line, "TODO") do
              message = "Найден мусор: #{String.trim(line)} (line #{line_no})"
              Memory.remember("scout", "short_term", message, %{file: file})
            end
          end)

        {:error, _reason} ->
          # ignore unreadable files
          :ok
      end
    end)
  end
end
