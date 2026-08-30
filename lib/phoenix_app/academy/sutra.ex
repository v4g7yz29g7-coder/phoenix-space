defmodule PhoenixApp.Academy.Sutra do
  @moduledoc """
  Смысл — неделимая единица мудрости в Академии.
  """
  use Ecto.Schema
  import Ecto.Changeset

  schema "sutras" do
    field :title, :string
    field :text, :string
    field :category, :string, default: "sutra"
    field :duration, :string
    field :color, :string
    field :icon, :string
    field :order, :integer, default: 0

    timestamps(type: :utc_datetime)
  end

  @doc false
  def changeset(sutra, attrs) do
    sutra
    |> cast(attrs, [:title, :text, :category, :duration, :color, :icon, :order])
    |> validate_required([:title, :text])
  end
end
