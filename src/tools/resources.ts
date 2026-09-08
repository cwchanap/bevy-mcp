/**
 * Fixed MCP-tool -> BRP-method mapping for the 5 direct resource tools
 * (captured 0.22.3 default contract). Method is never taken from caller input.
 */
export const RESOURCE_DIRECT = {
  world_list_resources: 'world.list_resources',
  world_get_resources: 'world.get_resources',
  world_insert_resources: 'world.insert_resources',
  world_remove_resources: 'world.remove_resources',
  world_mutate_resources: 'world.mutate_resources',
} as const;
