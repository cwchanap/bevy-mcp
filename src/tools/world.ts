/**
 * Fixed MCP-tool -> BRP-method mapping for the 12 direct world/registry tools
 * (captured 0.22.3 default contract). Method is never taken from caller input.
 */
export const WORLD_DIRECT = {
  world_list_components: 'world.list_components',
  world_get_components: 'world.get_components',
  world_despawn_entity: 'world.despawn_entity',
  world_insert_components: 'world.insert_components',
  world_remove_components: 'world.remove_components',
  world_mutate_components: 'world.mutate_components',
  world_query: 'world.query',
  world_spawn_entity: 'world.spawn_entity',
  world_trigger_event: 'world.trigger_event',
  registry_schema: 'registry.schema',
  world_reparent_entities: 'world.reparent_entities',
  rpc_discover: 'rpc.discover',
} as const;
