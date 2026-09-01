defmodule PhoenixApp.Agents.MemoryStub do
  @moduledoc """
  Временная файловая память.
  Использует встроенную сериализацию term_to_binary.
  """

  @file_path Path.expand("memory_stub.term", System.user_home!())

  def remember(agent_name, memory_type, content, metadata \\ %{}, _expires_at \\ nil) do
    record = %{
      agent_name: to_string(agent_name),
      memory_type: to_string(memory_type),
      content: content,
      metadata: metadata,
      inserted_at: DateTime.utc_now() |> DateTime.to_iso8601()
    }

    existing = read_records()
    File.write!(@file_path, :erlang.term_to_binary([record | existing]))

    {:ok, record}
  end

  def recall(agent_name, memory_type, limit \\ 20) do
    read_records()
    |> Enum.filter(&(&1.agent_name == to_string(agent_name) and &1.memory_type == to_string(memory_type)))
    |> Enum.take(limit)
  end

  defp read_records do
    case File.read(@file_path) do
      {:ok, binary} -> :erlang.binary_to_term(binary)
      _ -> []
    end
  end
end
