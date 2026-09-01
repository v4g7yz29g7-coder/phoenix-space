defmodule PhoenixApp.Repo.Migrations.CreateAgentsMemory do
  use Ecto.Migration

  def change do
    create table(:agents_memory) do
      add :agent_name, :string, null: false
      add :memory_type, :string
      add :content, :text
      add :metadata, :map, default: %{}
      add :expires_at, :utc_datetime
    end

    create index(:agents_memory, [:agent_name])
  end
end
