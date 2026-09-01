defmodule PhoenixApp.Agents.PublisherAdapter do
  @moduledoc """
  Behaviour для адаптеров публикации сообщений.

  Определяет контракт для модулей, которые будут публиковать сообщения
  в различные каналы (например, в Phoenix PubSub, внешние сервисы и т.д.).
  """

  @doc """
  Публикует сообщение.

  ## Параметры

    - message: сообщение для публикации (любой терм Elixir)

  ## Возвращаемое значение

    - `:ok` - если публикация успешна
    - `{:error, reason}` - если произошла ошибка

  ## Примеры

      iex> PublisherAdapter.publish(%{type: "user.created", data: %{id: 1}})
      :ok
  """
  @callback publish(message :: term()) :: :ok | {:error, term()}
end
