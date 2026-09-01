defmodule PhoenixApp.Agents.Memory do
  use Ecto.Schema
  import Ecto.Query

  alias PhoenixApp.Repo

  schema "agents_memory" do
    field :agent_name, :string
    field :memory_type, :string
    field :content, :string
    field :metadata, :map, default: %{}
    field :expires_at, :utc_datetime

    timestamps()
  end

  def changeset(memory, attrs) do
    memory
    |> Ecto.Changeset.cast(attrs, [:agent_name, :memory_type, :content, :metadata, :expires_at])
    |> Ecto.Changeset.validate_required([:agent_name, :memory_type, :content])
  end

  def remember(agent_name, memory_type, content, metadata \\ %{}) do
    agent_name = to_string(agent_name)
    memory_type = to_string(memory_type)

    %__MODULE__{}
    |> changeset(%{
      agent_name: agent_name,
      memory_type: memory_type,
      content: content,
      metadata: metadata
    })
    |> Repo.insert()
  end

  def recall(agent_name, memory_type, limit \\ 20) do
    agent_name = to_string(agent_name)
    memory_type = to_string(memory_type)

    query =
      from m in __MODULE__,
        where: m.agent_name == ^agent_name and m.memory_type == ^memory_type,
        order_by: [desc: m.inserted_at],
        limit: ^limit

    Repo.all(query)
  end
end
