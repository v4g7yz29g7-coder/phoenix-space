defmodule PhoenixApp.Repo.Migrations.AddContextToAgentsMemory do
  use Ecto.Migration

  def change do
    alter table(:agents_memory) do
      add :context_type, :string, null: true
      add :context_data, :map, default: %{}
    end
  end
end
