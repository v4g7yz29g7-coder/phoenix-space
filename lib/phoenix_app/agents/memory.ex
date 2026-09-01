defmodule PhoenixApp.Agents.Memory do
  use Ecto.Schema
  import Ecto.Query

  alias PhoenixApp.Repo

  @typedoc "Имя агента: :scout, :coder, :guardian, :reporter"
  @type agent_name :: atom() | String.t()

  @typedoc "Тип памяти: :short_term, :long_term, :global"
  @type memory_type :: atom() | String.t()

  schema "agents_memory" do
    field :agent_name, :string
    field :memory_type, :string
    field :content, :string
    field :metadata, :map, default: %{}
    field :expires_at, :utc_datetime

    timestamps()
  end

  @doc "Создать запись в памяти"
  def remember(agent_name, memory_type, content, metadata \\ %{}, expires_at \\ nil)
      when is_binary(content) do
    agent_name = to_string(agent_name)
    memory_type = to_string(memory_type)

    %__MODULE__{}
    |> changeset(%{
      agent_name: agent_name,
      memory_type: memory_type,
      content: content,
      metadata: metadata,
      expires_at: expires_at
    })
    |> Repo.insert()
  end

  @doc "Получить последние неистёкшие записи для агента"
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

  @doc "Удалить запись по id"
  def forget(id) when is_integer(id) do
    case Repo.get(__MODULE__, id) do
      nil -> {:error, :not_found}
      record -> Repo.delete(record)
    end
  end

  @doc "Удалить все истёкшие записи"
  def cleanup_expired do
    now = DateTime.utc_now()

    from(m in __MODULE__, where: not is_nil(m.expires_at) and m.expires_at < ^now)
    |> Repo.delete_all()
  end

  def changeset(memory, attrs) do
    memory
    |> Ecto.Changeset.cast(attrs, [:agent_name, :memory_type, :content, :metadata, :expires_at])
    |> Ecto.Changeset.validate_required([:agent_name, :memory_type, :content])
  end
end
