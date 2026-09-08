/**
 * Type-guide assembly: per-type guide construction, spawn/insert examples and
 * agent guidance.
 *
 * Ported from upstream `bevy_brp_mcp` 0.22.3 `brp_type_guide/guide.rs` and
 * `mutation_path_builder/api.rs` (`extract_spawn_insert_example`,
 * `spawn_insert_payload`), upstream commit
 * `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`, MIT licensed
 * (see THIRD_PARTY_NOTICES.md). Guidance/warning constants come from the Task 5
 * constants table in `model.ts` / `type-knowledge.ts` (never duplicated here).
 */
import type { Example, Json, Registry } from './model.js';
import { NOT_APPLICABLE, exampleToValue } from './model.js';
import { AGENT_GUIDANCE, ENTITY_WARNING, ERROR_GUIDANCE, notFoundInRegistry, processingFailed } from './model.js';
import { extractSchemaInfo, getFieldArray } from './schema-info.js';
import { getEntityExampleValue } from './type-knowledge.js';
import type { ExternalMutationPath, PathExample } from './mutation-paths.js';
import { buildMutationPaths, internalExampleOf, selectPreferredExample } from './mutation-paths.js';

const TYPE_BEVY_ENTITY = 'bevy_ecs::entity::Entity';

const SPAWN_COMPONENT_GUIDANCE =
  "The 'example' below can be used to spawn this component on an entity.";
const INSERT_RESOURCE_GUIDANCE = "The 'example' below can be used to insert this resource.";
const NO_COMPONENT_EXAMPLE_TEMPLATE =
  "This component does not have a {} example because the root mutation path is not 'mutable'.";
const NO_RESOURCE_EXAMPLE_TEMPLATE =
  "This resource does not have an {} example because the root mutation path is not 'mutable'.";

/**
 * Select the most useful example for spawn/insert from one external mutation
 * path (upstream `PathExample::preferred_example`): simple paths expose their
 * typed example; enum roots re-run the variant-group preference. Returns
 * undefined only when no example is available (NotApplicable).
 */
function preferredExample(path: ExternalMutationPath | undefined): Json | undefined {
  if (path === undefined) return undefined;
  const example = internalExampleOf(path);
  if (example === undefined) return undefined;
  const selected =
    example.kind === 'simple'
      ? example.example
      : (selectPreferredExample(example.groups) ?? NOT_APPLICABLE);
  return selected.kind === 'not-applicable' ? undefined : exampleToValue(selected);
}

/**
 * Spawn/insert example with guidance (upstream `extract_spawn_insert_example`
 * + `spawn_insert_payload`): `{"spawn": {...}}` for components,
 * `{"resource": {...}}` for resources, undefined for neither. The example
 * field is omitted when no example is available.
 */
function extractSpawnInsertExample(
  mutationPaths: readonly ExternalMutationPath[],
  reflectTraits: readonly string[],
): Json | undefined {
  const isComponent = reflectTraits.includes('Component');
  const isResource = reflectTraits.includes('Resource');
  if (!isComponent && !isResource) return undefined;

  const rootPath = mutationPaths.find((p) => p.path === '');
  const example = preferredExample(rootPath);

  if (isComponent) {
    return spawnInsertPayload(
      example === undefined
        ? NO_COMPONENT_EXAMPLE_TEMPLATE.replace('{}', 'spawn')
        : SPAWN_COMPONENT_GUIDANCE,
      example,
      'spawn',
    );
  }
  return spawnInsertPayload(
    example === undefined
      ? NO_RESOURCE_EXAMPLE_TEMPLATE.replace('{}', 'insert')
      : INSERT_RESOURCE_GUIDANCE,
    example,
    'resource',
  );
}

function spawnInsertPayload(
  agentGuidance: string,
  example: Json | undefined,
  field: 'spawn' | 'resource',
): Json {
  const payload: Record<string, Json> = { agent_guidance: agentGuidance };
  // Upstream omits the field only for null-equivalent examples; a JSON null
  // example is still emitted as `"example": null`.
  if (example !== undefined) payload['example'] = example;
  return { [field]: payload } as Json;
}

/** Agent guidance with the Entity warning appended when needed (upstream `generate_agent_guidance`). */
function generateAgentGuidance(
  mutationPaths: readonly ExternalMutationPath[],
): string {
  const hasEntity = mutationPaths.some((path) => path.path_info.type.includes(TYPE_BEVY_ENTITY));
  if (!hasEntity) return AGENT_GUIDANCE;
  const entityExample = String(getEntityExampleValue());
  return AGENT_GUIDANCE + ENTITY_WARNING.replace('{}', entityExample);
}

/** Serialized `type_guide` payload as it appears in the tool result. */
export type TypeGuideWire = {
  type_name: string;
  in_registry: boolean;
  agent_guidance: string;
  mutation_paths?: ExternalMutationPath[];
  schema_info?: unknown;
  error?: string;
} & Record<string, unknown>;

/** Reflection trait names from a registry schema. */
function reflectTraitsOf(registrySchema: Json): string[] {
  return (getFieldArray(registrySchema, 'reflectTypes') ?? []).filter(
    (t): t is string => typeof t === 'string',
  );
}

/**
 * Build the guide for one requested type name (upstream `TypeGuide::build`).
 * A missing registry entry is a valid not-found result; processing failures
 * surface as a guide with the ERROR guidance and an `error` field.
 */
export function buildTypeGuide(typeName: string, registry: Registry): TypeGuideWire {
  const registrySchema = registry.get(typeName);
  if (registrySchema === undefined) {
    // Not found is a valid result, not an error.
    return notFoundInRegistry(typeName, 'Type not found in registry') as TypeGuideWire;
  }

  let mutationPaths: ExternalMutationPath[];
  try {
    mutationPaths = buildMutationPaths(typeName, registry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return processingFailed(typeName, `Failed to process type: ${message}`) as TypeGuideWire;
  }

  const reflectTraits = reflectTraitsOf(registrySchema);
  const spawnInsertExample = extractSpawnInsertExample(mutationPaths, reflectTraits);
  const agentGuidance = generateAgentGuidance(mutationPaths);

  const spawnWire =
    spawnInsertExample === undefined
      ? {}
      : (spawnInsertExample as Record<string, Json>);

  return {
    type_name: typeName,
    in_registry: true,
    ...spawnWire,
    agent_guidance: agentGuidance,
    ...(mutationPaths.length > 0 ? { mutation_paths: mutationPaths } : {}),
    schema_info: extractSchemaInfo(registrySchema),
  };
}
