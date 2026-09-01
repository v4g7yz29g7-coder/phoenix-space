defmodule PhoenixApp.Agents.FrontendCoordinator do
  @moduledoc """
  Автономный координатор исправлений фронтенда.
  Обходит все .heex файлы в live-папке и применяет исправления.
  """

  alias PhoenixApp.Agents.{FrontendFixer, ContentCleaner}

  @dir "/home/ishidin/phoenix_app/lib/phoenix_app_web/live"

  def run do
    files = Path.wildcard(Path.join(@dir, "**/*.heex"))

    Enum.each(files, &process_file/1)

    IO.puts("Обработано файлов: #{length(files)}")
  end

  defp process_file(file) do
    content = File.read!(file)

    new_content =
      content
      |> FrontendFixer.fix_mobile()
      |> ContentCleaner.replace_placeholders()

    if new_content != content do
      File.write!(file, new_content)
      IO.puts("Исправлен: #{file}")
    end
  end
end
