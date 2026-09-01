defmodule PhoenixApp.Agents.Memory do
  use Ecto.Schema
  import Ecto.Query
  import Ecto.Changeset

  alias PhoenixApp.Repo

  schema "agents_memory" do
    field :agent_name, :string
    field :memory_type, :string
    field :content, :string
    field :metadata, :map, default: %{}
    field :expires_at, :utc_datetime
    field :context_type, :string
    field :context_data, :map, default: %{}

    timestamps()
  end

  def changeset(memory, attrs) do
    memory
    |> cast(attrs, [:agent_name, :memory_type, :content, :metadata, :expires_at, :context_type, :context_data])
    |> validate_required([:agent_name, :memory_type, :content])
  end

  # Универсальное хранилище фактов и задач
  def remember(agent_name, memory_type, content, metadata \\ %{}, expires_at \\ nil) do
    %__MODULE__{}
    |> changeset(%{agent_name: to_string(agent_name), memory_type: to_string(memory_type), content: content, metadata: metadata, expires_at: expires_at})
    |> Repo.insert()
  end

  def recall(agent_name, memory_type, limit \\ 20) do
    agent_name = to_string(agent_name)
    memory_type = to_string(memory_type)
    now = DateTime.utc_now()

    from(m in __MODULE__,
      where: m.agent_name == ^agent_name and m.memory_type == ^memory_type,
      where: is_nil(m.expires_at) or m.expires_at > ^now,
      order_by: [desc: m.inserted_at],
      limit: ^limit
    )
    |> Repo.all()
  end

  def forget(id) when is_integer(id) do
    case Repo.get(__MODULE__, id) do
      nil -> {:error, :not_found}
      rec -> Repo.delete(rec)
    end
  end

  def cleanup_expired do
    now = DateTime.utc_now()

    from(m in __MODULE__, where: not is_nil(m.expires_at) and m.expires_at < ^now)
    |> Repo.delete_all()
  end

  # Контекст для агентов: store_context/3, get_context/1
  def store_context(agent_name, context_type, context_data) do
    %__MODULE__{}
    |> changeset(%{
      agent_name: to_string(agent_name),
      memory_type: "context",
      content: "контекст",
      metadata: %{},
      context_type: to_string(context_type),
      context_data: context_data
    })
    |> Repo.insert()
  end

  def get_context(agent_name) do
    agent_name = to_string(agent_name)

    from(m in __MODULE__,
      where: m.agent_name == ^agent_name and m.memory_type == "context",
      order_by: [desc: m.inserted_at],
      limit: 1
    )
    |> Repo.one()
    |> case do
      nil -> {:error, :not_found}
      rec -> {:ok, rec}
    end
  end
end
