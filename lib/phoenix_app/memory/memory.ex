defmodule PhoenixApp.Memory do
  @moduledoc """
  Memory management module for the PhoenixApp.
  Provides functions to store, retrieve, and manage memory entries.
  """

  alias PhoenixApp.Memory.MemoryStore

  @doc """
  Store a memory entry.
  """
  def store(key, value) do
    MemoryStore.store(key, value)
  end

  @doc """
  Retrieve a memory entry.
  """
  def get(key) do
    MemoryStore.get(key)
  end

  @doc """
  Delete a memory entry.
  """
  def delete(key) do
    MemoryStore.delete(key)
  end

  @doc """
  List all memory entries.
  """
  def list_all do
    MemoryStore.list_all()
  end

  @doc """
  Clear all memory entries.
  """
  def clear do
    MemoryStore.clear()
  end
end
