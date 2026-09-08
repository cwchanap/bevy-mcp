/**
 * Core data model for the Bevy type-guide pipeline.
 *
 * Ported from the pinned upstream `bevy_brp_mcp` 0.22.3 type-guide modules
 * (`response.rs`, `type_kind.rs`, `path_example.rs`, `variant_signature.rs`,
 * `guide.rs` and `mutation_path_builder/support.rs`), upstream commit
 * `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`, distributed under the MIT
 * license (see THIRD_PARTY_NOTICES.md).
 *
 * Task 6 (mutation paths + guidance assembly + public tools) builds on these
 * types; this module only owns the shared vocabulary.
 */

/** JSON value as exchanged with BRP registry schemas and guide output. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** Type registry keyed by fully-qualified type name, as returned by `registry.schema`. */
export type Registry = Map<string, Json>;

/** Type kinds reported by the registry schema `kind` field (upstream `TypeKind`). */
export type TypeKind =
  | 'Array'
  | 'Enum'
  | 'List'
  | 'Map'
  | 'Struct'
  | 'Set'
  | 'Tuple'
  | 'TupleStruct'
  | 'Value';

const TYPE_KINDS: readonly TypeKind[] = [
  'Array',
  'Enum',
  'List',
  'Map',
  'Struct',
  'Set',
  'Tuple',
  'TupleStruct',
  'Value',
];

/**
 * Parse a registry schema into its `TypeKind`, falling back to `'Value'`.
 *
 * Some types have no `kind` field (opaque external types like `Uuid`/`Entity`,
 * `NonZero*`, primitives without full reflection data); they are safely
 * treated as leaf `Value` types. (upstream `type_kind.rs` `From<&Value>`.)
 */
export function parseTypeKind(schema: Json): TypeKind {
  const kind =
    typeof schema === 'object' && schema !== null && !Array.isArray(schema)
      ? schema['kind']
      : undefined;
  return typeof kind === 'string' && (TYPE_KINDS as readonly string[]).includes(kind)
    ? (kind as TypeKind)
    : 'Value';
}

/**
 * Maximum recursion depth for type example generation to prevent infinite
 * loops on self-referencing types (upstream `constants.rs`
 * `MAX_TYPE_RECURSION_DEPTH`).
 */
export const MAX_TYPE_RECURSION_DEPTH = 10;

/** Schema information extracted from the registry schema (upstream `SchemaInfo`). */
export interface SchemaInfo {
  /** Category of the type (Struct, Enum, ...); absent when `kind` is missing/invalid. */
  type_kind?: TypeKind;
  /** Field definitions from the registry schema. */
  properties?: Json;
  /** Required fields list. */
  required?: string[];
  /** Module path of the type. */
  module_path?: string;
  /** Crate name of the type. */
  crate_name?: string;
  /** Reflection traits (`Component`, `Resource`, `Serialize`, `Default`, ...). */
  reflect_traits?: string[];
  /** Component metadata from Bevy's ECS registry. */
  component_info?: Json;
}

/**
 * Serialized `type_guide` payload returned for a single type name
 * (upstream `guide.rs` `TypeGuide`).
 */
export interface TypeGuide {
  /** Fully-qualified type name. */
  type_name: string;
  /** Whether the type is registered in the Bevy registry. */
  in_registry: boolean;
  /** Example format for spawn/insert operations with guidance. */
  spawn_insert_example?: unknown;
  /** Guidance for AI agents about using mutation paths. */
  agent_guidance: string;
  /** Mutation paths available for this type. */
  mutation_paths?: unknown[];
  /** Schema information from the registry. */
  schema_info?: unknown;
  /** Error message if discovery failed. */
  error?: string;
}

/**
 * Example value for a mutation path (upstream `path_example.rs` `Example`).
 *
 * `option-none` is an explicit `Option::None` (serializes to `null`);
 * `not-applicable` means no example is available (the value is omitted).
 */
export type Example =
  | { readonly kind: 'json'; readonly value: Json }
  | { readonly kind: 'option-none' }
  | { readonly kind: 'not-applicable' };

export const NOT_APPLICABLE: Example = { kind: 'not-applicable' };

export function jsonExample(value: Json): Example {
  return { kind: 'json', value };
}

/** Convert an example to its JSON value (`null` for `option-none`/`not-applicable`). */
export function exampleToValue(example: Example): Json {
  switch (example.kind) {
    case 'json':
      return example.value;
    case 'option-none':
    case 'not-applicable':
      return null;
  }
}

/** Fully-qualified enum variant name (upstream `VariantName`), e.g. `"Color::Srgba"`. */
export type VariantName = string;

/** Short variant name without the enum prefix, e.g. `"Color::Srgba"` → `"Srgba"`. */
export function variantShortName(name: VariantName): string {
  const pos = name.lastIndexOf('::');
  return pos === -1 ? name : name.slice(pos + 2);
}

/** Structure of an enum variant (upstream `VariantSignature`). */
export type VariantSignature =
  | { readonly variant: 'Unit' }
  | { readonly variant: 'Tuple'; readonly types: readonly string[] }
  | {
      readonly variant: 'Struct';
      readonly fields: readonly { readonly name: string; readonly typeName: string }[];
    };

/**
 * Canonical string form of a variant signature; used for grouping identity and
 * deterministic ordering (upstream sorts by the derived `Ord` of the Rust
 * enum: Unit < Tuple < Struct, then by contents).
 */
export function variantSignatureKey(signature: VariantSignature): string {
  switch (signature.variant) {
    case 'Unit':
      return '';
    case 'Tuple':
      return signature.types.join(',');
    case 'Struct':
      return signature.fields.map((f) => `${f.name},${f.typeName}`).join(';');
  }
}

/** Deterministic ordering of variant signatures (upstream `VariantSignature: Ord`). */
export function compareVariantSignatures(a: VariantSignature, b: VariantSignature): number {
  const rank = { Unit: 0, Tuple: 1, Struct: 2 } as const;
  if (rank[a.variant] !== rank[b.variant]) return rank[a.variant] - rank[b.variant];
  const ka = variantSignatureKey(a);
  const kb = variantSignatureKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Status of whether a mutation path can be mutated (upstream `Mutability`).
 *
 * Example values depend on mutability: partially-mutable parents assemble
 * their examples from only their mutable children, and non-mutable paths carry
 * no example at all.
 */
export type Mutability = 'Mutable' | 'PartiallyMutable' | 'NotMutable';

/**
 * Aggregate multiple mutation statuses into a single status
 * (upstream `mutation_path_builder/support.rs` `aggregate_mutability`).
 *
 * - If any `PartiallyMutable` OR (has both `Mutable` and `NotMutable`) → `PartiallyMutable`
 * - Else if any `NotMutable` → `NotMutable`
 * - Else → `Mutable`
 */
export function aggregateMutability(statuses: readonly Mutability[]): Mutability {
  const hasPartiallyMutable = statuses.some((s) => s === 'PartiallyMutable');
  const hasMutable = statuses.some((s) => s === 'Mutable');
  const hasNotMutable = statuses.some((s) => s === 'NotMutable');
  if (hasPartiallyMutable || (hasMutable && hasNotMutable)) return 'PartiallyMutable';
  if (hasNotMutable) return 'NotMutable';
  return 'Mutable';
}

/**
 * Control-flow decision after consulting the knowledge base
 * (upstream `type_knowledge.rs` `KnowledgeAction`).
 */
export type KnowledgeAction =
  | { readonly action: 'complete-with-example'; readonly example: Json }
  | { readonly action: 'use-example-and-recurse'; readonly example: Json }
  | { readonly action: 'missing' };

/** Typed failure during guide construction; converted into a per-type `error`, never a crash. */
export class TypeGuideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeGuideError';
  }
}

/** Base guidance constant for type guides (upstream `constants.rs`). */
export const AGENT_GUIDANCE =
  "The 'mutation_paths' field provides valid 'path' arguments for 'mcp__brp__world_mutate_components' and 'mcp__brp__world_mutate_resources' tools, with example values suitable for testing.";

/** Additional warning when Entity fields are present (`{}` = example entity ID). */
export const ENTITY_WARNING =
  ' CAUTION: This type contains bevy_ecs::entity::Entity fields - you must use valid Entity IDs from the running app to replace the example value \'{}\'. Invalid Entity values may crash the application.';

/** Guidance for types found in the registry but failed during processing. */
export const ERROR_GUIDANCE =
  "This type was found in the registry but failed during processing. Check the 'error' field for details. No mutation paths or spawn format are available due to the processing failure.";

/** Guide for a type that is not present in the registry (valid result, not an error). */
export function notFoundInRegistry(typeName: string, errorMessage: string): TypeGuide {
  return {
    type_name: typeName,
    in_registry: false,
    agent_guidance: AGENT_GUIDANCE,
    error: errorMessage,
  };
}

/** Guide for a registered type whose processing failed; surfaces `error` instead of crashing. */
export function processingFailed(typeName: string, errorMessage: string): TypeGuide {
  return {
    type_name: typeName,
    in_registry: true,
    agent_guidance: ERROR_GUIDANCE,
    error: errorMessage,
  };
}
