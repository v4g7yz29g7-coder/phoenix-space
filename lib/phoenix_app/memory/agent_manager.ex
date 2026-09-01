defmodule PhoenixApp.Memory.AgentManager do
  @moduledoc """
  GenServer for managing agent processes.
  """

  use GenServer

  # Client API

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def register_agent(agent_id, pid) do
    GenServer.call(__MODULE__, {:register, agent_id, pid})
  end

  def unregister_agent(agent_id) do
    GenServer.call(__MODULE__, {:unregister, agent_id})
  end

  def get_agent(agent_id) do
    GenServer.call(__MODULE__, {:get, agent_id})
  end

  def list_agents do
    GenServer.call(__MODULE__, :list)
  end

  # Server callbacks

  @impl true
  def init(initial_state) do
    {:ok, initial_state}
  end

  @impl true
  def handle_call({:register, agent_id, pid}, _from, state) do
    new_state = Map.put(state, agent_id, pid)
    {:reply, :ok, new_state}
  end

  @impl true
  def handle_call({:unregister, agent_id}, _from, state) do
    new_state = Map.delete(state, agent_id)
    {:reply, :ok, new_state}
  end

  @impl true
  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state, agent_id), state}
  end

  @impl true
  def handle_call(:list, _from, state) do
    {:reply, state, state}
  end
end
