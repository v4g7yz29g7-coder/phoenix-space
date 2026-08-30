defmodule PhoenixApp.Accounts do
  @moduledoc """
  Контекст Accounts — работа с пользователями и аутентификацией.
  """
  alias PhoenixApp.Repo
  alias PhoenixApp.Accounts.User

  def register_user(attrs \\ %{}) do
    %User{}
    |> User.changeset(attrs)
    |> Repo.insert()
  end

  def get_user_by_email(email) when is_binary(email) do
    Repo.get_by(User, email: email)
  end

  def get_user!(id), do: Repo.get!(User, id)

  def authenticate_by_email_and_pass(email, password) when is_binary(email) and is_binary(password) do
    user = get_user_by_email(email)

    cond do
      user && Argon2.verify_pass(password, user.password_hash) ->
        {:ok, user}

      user ->
        {:error, :unauthorized}

      true ->
        # Защита от тайминговых атак
        Argon2.no_user_verify()
        {:error, :unauthorized}
    end
  end
end
