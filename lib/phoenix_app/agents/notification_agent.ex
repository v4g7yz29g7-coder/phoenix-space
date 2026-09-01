defmodule PhoenixApp.Agents.NotificationAgent do
  @moduledoc """
  Агент для отправки уведомлений в консоль.
  """

  @doc """
  Отправляет уведомление в консоль.

  ## Параметры

    - message: строка с текстом уведомления
    - level: атом уровня уведомления (:info, :warning, :error)

  ## Примеры

      iex> PhoenixApp.Agents.NotificationAgent.notify("Тестовое сообщение", :info)
      [INFO] Тестовое сообщение
      :ok

      iex> PhoenixApp.Agents.NotificationAgent.notify("Ошибка!", :error)
      [ERROR] Ошибка!
      :ok
  """
  @spec notify(String.t(), atom()) :: :ok
  def notify(message, level) when is_binary(message) and is_atom(level) do
    formatted_message = format_message(message, level)
    IO.puts(formatted_message)
    :ok
  end

  # Валидация входных данных
  def notify(message, level) when not is_binary(message) do
    raise ArgumentError, "message must be a string, got: #{inspect(message)}"
  end

  def notify(message, level) when not is_atom(level) do
    raise ArgumentError, "level must be an atom, got: #{inspect(level)}"
  end

  # Приватная функция для форматирования сообщения
  defp format_message(message, level) do
    level_string = level
    |> Atom.to_string()
    |> String.upcase()

    "[#{level_string}] #{message}"
  end
end
