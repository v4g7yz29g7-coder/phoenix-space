defmodule PhoenixApp.Academy do
  @moduledoc """
  Контекст Академии — работа с Смыслами и Практиками.
  """
  import Ecto.Query
  alias PhoenixApp.Repo
  alias PhoenixApp.Academy.Sutra

  def list_sutras do
    Repo.all(from s in Sutra, where: s.category == "sutra", order_by: [asc: s.order])
  end

  def list_practices do
    Repo.all(from s in Sutra, where: s.category == "practice", order_by: [asc: s.order])
  end

  def get_sutra!(id), do: Repo.get!(Sutra, id)

  def create_sutra(attrs \\ %{}) do
    %Sutra{}
    |> Sutra.changeset(attrs)
    |> Repo.insert()
  end
end
