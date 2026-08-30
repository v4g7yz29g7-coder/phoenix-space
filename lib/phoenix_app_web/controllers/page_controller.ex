defmodule PhoenixAppWeb.PageController do
  use PhoenixAppWeb, :controller

  def set_locale(conn, %{"locale" => locale}) when locale in ["ru", "en", "es", "fr", "de", "zh", "ar", "hi"] do
    Gettext.put_locale(PhoenixAppWeb.Gettext, locale)

    # Возвращаемся на предыдущую страницу или на главную
    referer = conn.req_headers |> Enum.into(%{}) |> Map.get("referer", "/")

    conn
    |> put_session(:locale, locale)
    |> redirect(external: referer)
  end

  def set_locale(conn, _params) do
    redirect(conn, to: "/")
  end
end
