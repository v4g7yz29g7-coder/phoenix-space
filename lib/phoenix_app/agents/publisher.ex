defmodule PhoenixApp.Agents.Publisher do
  @moduledoc """
  Публикация контента: вывод в консоль и сохранение факта в память.
  """

  alias PhoenixApp.Agents.MemoryStub, as: Memory

  @spec publish(String.t()) :: :ok
  def publish(draft) when is_binary(draft) do
    IO.puts(draft)

    Memory.remember(
      "publisher",
      "short_term",
      "Опубликован черновик",
      %{draft: draft}
    )

    :ok
  end

  def publish(_invalid) do
    raise ArgumentError, "draft must be a string"
  end
end
