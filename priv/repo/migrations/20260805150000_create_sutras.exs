defmodule PhoenixApp.Repo.Migrations.CreateSutras do
  use Ecto.Migration

  def change do
    create table(:sutras) do
      add :title, :string, null: false
      add :text, :text, null: false
      add :category, :string, default: "sutra"
      add :duration, :string
      add :color, :string
      add :icon, :string
      add :order, :integer, default: 0

      timestamps(type: :utc_datetime)
    end

    create index(:sutras, [:category])
    create index(:sutras, [:order])
  end
end
