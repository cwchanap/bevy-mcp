/**
 * Example-value construction for the Bevy type guides.
 *
 * Given a fully-qualified type name and the `registry.schema` map, recursively
 * assembles the BRP example JSON value for that type, consulting the curated
 * knowledge base first and recursing through struct fields, tuple elements,
 * containers and enum variants otherwise.
 *
 * Substantially translated from upstream `bevy_brp_mcp` 0.22.3 modules
 * `mutation_path_builder/path_builder.rs` (knowledge dispatch, mutability
 * aggregation, example selection), `mutation_path_builder/type_kind_builder/*`
 * (per-kind child collection and example assembly),
 * `mutation_path_builder/enum_builder/enum_path_builder.rs` (variant grouping
 * and example building, example-relevant parts),
 * `mutation_path_builder/option_classification.rs`,
 * `mutation_path_builder/constants.rs` and
 * `mutation_path_builder/support.rs` (`assemble_struct_from_children`),
 * upstream commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`, MIT licensed
 * (see THIRD_PARTY_NOTICES.md).
 *
 * The mutation-path machinery that upstream fuses into this traversal
 * (path accumulation, `NotMutableReason` payloads, partial root examples,
 * variant chains) is Task 6 scope; this module produces exactly the
 * `(example, mutability)` results a parent node consumes, so Task 6 can reuse
 * or extend the same per-kind structure.
 */
import type {
  Example,
  Json,
  KnowledgeAction,
  Mutability,
  Registry,
  TypeKind,
  VariantSignature,
} from './model.js';
import {
  MAX_TYPE_RECURSION_DEPTH,
  NOT_APPLICABLE,
  aggregateMutability,
  compareVariantSignatures,
  jsonExample,
  exampleToValue,
  parseTypeKind,
  variantShortName,
  variantSignatureKey,
  TypeGuideError,
} from './model.js';
import type { KnowledgeKey, TypeKnowledgeEntry } from './type-knowledge.js';
import { getKnowledge } from './type-knowledge.js';
import {
  extractFieldType,
  getField,
  getFieldArray,
  getProperties,
  isHandle,
  parseEnumVariants,
} from './schema-info.js';
import type { VariantKind } from './schema-info.js';

// Example-generation constants (upstream `mutation_path_builder/constants.rs`).
/** Default element count when an array's size cannot be inferred from its type name. */
const DEFAULT_ARRAY_EXAMPLE_LENGTH = 2;

// Option type classification (upstream `option_classification.rs`).
const OPTION_PREFIX = 'core::option::Option<';
const OPTION_SOME_FIELD = 'Some';

/**
 * Where a node sits in its parent type; drives priority knowledge lookup
 * (upstream reads the same facts from `RecursionContext.path_kind` /
 * `parent_variant_signature`).
 */
export interface ValueContext {
  /** Fully-qualified type name of this node. */
  readonly typeName: string;
  /** Recursion depth (0 = root). */
  readonly depth: number;
  /** Parent type when this node is a struct field, map key/value, set item or tuple element. */
  readonly parentType?: string;
  /** Field name when this node is a struct field or map/set child. */
  readonly fieldName?: string;
  /** Index when this node is a tuple element or enum variant tuple element. */
  readonly index?: number;
  /** Signature of the enclosing enum variant (children of enum variants). */
  readonly parentVariantSignature?: VariantSignature;
}

/** Example value plus mutation status for one type node. */
export interface TypeExample {
  /** `not-applicable` when `mutability` is `'NotMutable'`. */
  readonly example: Example;
  readonly mutability: Mutability;
}

const NOT_MUTABLE_EXAMPLE: TypeExample = { example: NOT_APPLICABLE, mutability: 'NotMutable' };

/**
 * Build the BRP example value for a type (upstream
 * `path_builder::recurse_mutation_paths`, example-relevant behavior).
 *
 * Throws {@link TypeGuideError} for malformed schemas; callers convert that
 * into a per-type `error` result instead of crashing the whole request.
 */
export function buildValueExample(registry: Registry, ctx: ValueContext): TypeExample {
  const schema = registry.get(ctx.typeName);
  if (schema === undefined) return NOT_MUTABLE_EXAMPLE; // NotInRegistry
  if (ctx.depth > MAX_TYPE_RECURSION_DEPTH) return NOT_MUTABLE_EXAMPLE; // RecursionLimitExceeded

  const kind = parseTypeKind(schema);
  return kind === 'Enum'
    ? buildEnumExample(registry, ctx, schema)
    : buildNonEnumExample(registry, ctx, schema, kind);
}

// ===== Knowledge dispatch (upstream `RecursionContext::find_knowledge`/`check_knowledge`) =====

function findKnowledgeEntry(ctx: ValueContext): TypeKnowledgeEntry | undefined {
  if (ctx.parentType !== undefined) {
    // Struct-field knowledge first - overrides generic type knowledge
    // (e.g. Camera3d.depth_texture_usages needs 20, not the generic u32 value).
    if (ctx.fieldName !== undefined) {
      const key: KnowledgeKey = {
        kind: 'struct-field',
        structType: ctx.parentType,
        fieldName: ctx.fieldName,
      };
      const hit = getKnowledge(key);
      if (hit !== undefined) return hit;
    } else if (ctx.index !== undefined && ctx.parentVariantSignature?.variant === 'Tuple') {
      // Enum variant tuple element knowledge (e.g. AlphaMode2d::Mask(f32).0 = 0.5).
      const key: KnowledgeKey = {
        kind: 'enum-variant-signature',
        enumType: ctx.parentType,
        signature: ctx.parentVariantSignature,
        index: ctx.index,
      };
      const hit = getKnowledge(key);
      if (hit !== undefined) return hit;
    }
    // Fall through to exact type match.
  }
  return getKnowledge({ kind: 'exact', typeName: ctx.typeName });
}

/** Single interpretation point translating knowledge facts into control flow. */
function checkKnowledge(ctx: ValueContext): KnowledgeAction {
  const entry = findKnowledgeEntry(ctx);
  if (entry === undefined) return { action: 'missing' };
  if (entry.kind === 'treat-as-root-value') {
    return { action: 'complete-with-example', example: entry.example };
  }
  return { action: 'use-example-and-recurse', example: entry.example };
}

// ===== Non-enum types (upstream `MutationPathBuilder` + type_kind_builders) =====

function buildNonEnumExample(
  registry: Registry,
  ctx: ValueContext,
  schema: Json,
  kind: TypeKind,
): TypeExample {
  const knowledge = checkKnowledge(ctx);
  if (knowledge.action === 'complete-with-example') {
    // Opaque type - use the curated example as the root value, do not recurse.
    return { example: jsonExample(knowledge.example), mutability: 'Mutable' };
  }

  // Collect children per kind (upstream `collect_children`).
  const children = new Map<string, TypeExample>();
  let tupleElementTypes: readonly string[] = [];
  switch (kind) {
    case 'Struct': {
      const properties = getProperties(schema);
      if (properties !== undefined) {
        for (const [fieldName, fieldSchema] of Object.entries(properties)) {
          const fieldType = extractFieldType(fieldSchema);
          if (fieldType === undefined) {
            throw new TypeGuideError(
              `Failed to extract type for field '${fieldName}' in struct '${ctx.typeName}'`,
            );
          }
          children.set(
            fieldName,
            buildValueExample(registry, {
              typeName: fieldType,
              depth: ctx.depth + 1,
              parentType: ctx.typeName,
              fieldName,
              parentVariantSignature: ctx.parentVariantSignature,
            }),
          );
        }
      }
      break;
    }
    case 'Tuple':
    case 'TupleStruct': {
      const prefixItems = getFieldArray(schema, 'prefixItems') ?? [];
      tupleElementTypes = prefixItems.map((item, index) => {
        const elementType = extractFieldType(item);
        if (elementType === undefined) {
          throw new TypeGuideError(
            `Failed to extract type for element ${index} in tuple '${ctx.typeName}'`,
          );
        }
        return elementType;
      });
      prefixItems.forEach((_, index) => {
        const elementType = tupleElementTypes[index]!;
        children.set(
          String(index),
          buildValueExample(registry, {
            typeName: elementType,
            depth: ctx.depth + 1,
            parentType: ctx.typeName,
            index,
            parentVariantSignature: ctx.parentVariantSignature,
          }),
        );
      });
      break;
    }
    case 'Array':
    case 'List': {
      const elementType = extractFieldType(getField(schema, 'items') ?? null);
      if (elementType === undefined) {
        throw new TypeGuideError(
          `Failed to extract element type from schema for ${kind.toLowerCase()}: ${ctx.typeName}`,
        );
      }
      // ArrayElement path kinds only ever match exact knowledge - no parent keys.
      children.set(
        '0',
        buildValueExample(registry, {
          typeName: elementType,
          depth: ctx.depth + 1,
          parentVariantSignature: ctx.parentVariantSignature,
        }),
      );
      break;
    }
    case 'Map': {
      const keyType = extractFieldType(getField(schema, 'keyType') ?? null);
      if (keyType === undefined) {
        throw new TypeGuideError(
          `Failed to extract key type from schema for type: ${ctx.typeName}`,
        );
      }
      const valueType = extractFieldType(getField(schema, 'valueType') ?? null);
      if (valueType === undefined) {
        throw new TypeGuideError(
          `Failed to extract value type from schema for type: ${ctx.typeName}`,
        );
      }
      children.set(
        'key',
        buildValueExample(registry, {
          typeName: keyType,
          depth: ctx.depth + 1,
          parentType: ctx.typeName,
          fieldName: 'key',
          parentVariantSignature: ctx.parentVariantSignature,
        }),
      );
      children.set(
        'value',
        buildValueExample(registry, {
          typeName: valueType,
          depth: ctx.depth + 1,
          parentType: ctx.typeName,
          fieldName: 'value',
          parentVariantSignature: ctx.parentVariantSignature,
        }),
      );
      break;
    }
    case 'Set': {
      const itemType = extractFieldType(getField(schema, 'items') ?? null);
      if (itemType === undefined) {
        throw new TypeGuideError(
          `Failed to extract item type from schema for type: ${ctx.typeName}`,
        );
      }
      children.set(
        'items',
        buildValueExample(registry, {
          typeName: itemType,
          depth: ctx.depth + 1,
          parentType: ctx.typeName,
          fieldName: 'items',
          parentVariantSignature: ctx.parentVariantSignature,
        }),
      );
      break;
    }
    case 'Value':
      // Leaf type without mutation knowledge - no example available.
      return NOT_MUTABLE_EXAMPLE;
    case 'Enum':
      return NOT_MUTABLE_EXAMPLE; // unreachable; handled by buildEnumExample
  }

  // Parent mutability (upstream `determine_parent_mutability`).
  // SPECIAL CASE: Maps and Sets require ALL children to be mutable for BRP operations.
  const childStatuses = [...children.values()].map((c) => c.mutability);
  const mutability: Mutability =
    (kind === 'Map' || kind === 'Set') && childStatuses.some((s) => s === 'NotMutable')
      ? 'NotMutable'
      : aggregateMutability(childStatuses);

  if (mutability === 'NotMutable') return NOT_MUTABLE_EXAMPLE;

  if (mutability === 'Mutable') {
    if (knowledge.action === 'use-example-and-recurse') {
      return { example: jsonExample(knowledge.example), mutability };
    }
    const assembled = assembleFromChildren(ctx.typeName, kind, children, tupleElementTypes, () =>
      true,
    );
    // Assembly failure (e.g. complex map key) forces NotMutable.
    if (assembled === undefined) return NOT_MUTABLE_EXAMPLE;
    return { example: jsonExample(assembled), mutability };
  }

  // PartiallyMutable: assemble from only the mutable children.
  const partial = assembleFromChildren(
    ctx.typeName,
    kind,
    children,
    tupleElementTypes,
    (child) => child.mutability === 'Mutable',
  );
  return { example: partial === undefined ? NOT_APPLICABLE : jsonExample(partial), mutability };
}

/**
 * Assemble a parent value from child examples (upstream `assemble_from_children`
 * in each `type_kind_builder`). Returns `undefined` for assembly failures that
 * upstream models as `NotMutable` (handle wrappers, complex collection keys).
 */
function assembleFromChildren(
  typeName: string,
  kind: TypeKind,
  children: ReadonlyMap<string, TypeExample>,
  tupleElementTypes: readonly string[],
  include: (child: TypeExample) => boolean,
): Json | undefined {
  const values = new Map<string, Json>();
  for (const [descriptor, child] of children) {
    if (include(child)) values.set(descriptor, exampleToValue(child.example));
  }

  switch (kind) {
    case 'Struct': {
      // Empty struct (marker struct) assembles to {}.
      const obj: Record<string, Json> = {};
      // Deterministic field ordering: sort keys by string representation.
      for (const key of [...values.keys()].sort()) obj[key] = values.get(key)!;
      return obj;
    }
    case 'Tuple':
    case 'TupleStruct': {
      // Single-element Handle wrappers are immutable (Arc internals).
      if (tupleElementTypes.length === 1 && isHandle(tupleElementTypes[0]!)) return undefined;
      const items: Json[] = [];
      for (let index = 0; index < tupleElementTypes.length; index++) {
        items.push(values.get(String(index)) ?? null);
      }
      // Single-field tuple structs are unwrapped by BRP - return the inner value.
      if (items.length === 1) return items[0]!;
      if (items.length === 0) return null;
      return items;
    }
    case 'Array': {
      const element = values.get('0');
      if (element === undefined) return null;
      const size = extractArraySize(typeName) ?? DEFAULT_ARRAY_EXAMPLE_LENGTH;
      return Array.from({ length: size }, () => element);
    }
    case 'List': {
      const element = values.get('0');
      if (element === undefined) return null;
      return [element];
    }
    case 'Map': {
      const key = values.get('key');
      const value = values.get('value');
      if (key === undefined || value === undefined) return null;
      if (isComplexValue(key)) return undefined; // ComplexCollectionKey
      return { [mapKeyString(key)]: value };
    }
    case 'Set': {
      const item = values.get('items');
      if (item === undefined) return null;
      if (isComplexValue(item)) return undefined; // ComplexCollectionKey
      return [item, item];
    }
    case 'Value':
    case 'Enum':
      return null; // unreachable for assembled kinds
  }
}

/** Extract array size from a type name (e.g. `"[glam::Vec3; 2]"` → `2`). */
function extractArraySize(typeName: string): number | undefined {
  const semi = typeName.lastIndexOf('; ');
  const close = typeName.lastIndexOf(']');
  if (semi === -1 || close === -1 || semi + 2 > close) return undefined;
  const sizeStr = typeName.slice(semi + 2, close);
  if (!/^\d+$/.test(sizeStr)) return undefined;
  const size = Number(sizeStr);
  // Upstream parses the digits into `usize` and materializes the full valid
  // length; an overflowing literal fails the parse and falls back to the
  // default length. JS has no usize — the safe-integer bound is the closest
  // faithful equivalent (past it the digits no longer round-trip exactly).
  return Number.isSafeInteger(size) ? size : undefined;
}

/** Complex (non-primitive) values cannot be map keys or set elements. */
function isComplexValue(value: Json): boolean {
  return Array.isArray(value) || (typeof value === 'object' && value !== null);
}

/** Convert a primitive key to its string form (JSON map keys must be strings). */
function mapKeyString(key: Json): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'number' || typeof key === 'boolean') return String(key);
  if (key === null) return 'null';
  throw new TypeGuideError(`Unexpected complex key type after complexity check: ${JSON.stringify(key)}`);
}

// ===== Enum types (upstream `enum_builder::process_enum`, example parts) =====

interface VariantGroup {
  readonly signature: VariantSignature;
  readonly names: readonly string[];
  /** Omitted for variants that cannot be fully constructed. */
  readonly example?: Example;
  readonly mutability: Mutability;
}

function buildEnumExample(registry: Registry, ctx: ValueContext, schema: Json): TypeExample {
  const knowledge = checkKnowledge(ctx);
  if (knowledge.action === 'complete-with-example') {
    return { example: jsonExample(knowledge.example), mutability: 'Mutable' };
  }

  // Group variants by signature, deterministic order (upstream `group_variants_by_signature`).
  const variants = parseEnumVariants(schema, ctx.typeName);
  const groups: VariantGroup[] = [];
  const grouped = groupVariantsBySignature(variants);
  for (const [signature, names] of grouped) {
    // Collect child examples for this signature group.
    const children = new Map<string, TypeExample>();
    if (signature.variant === 'Tuple') {
      signature.types.forEach((typeName, index) => {
        children.set(
          String(index),
          buildValueExample(registry, {
            typeName,
            depth: ctx.depth + 1,
            parentType: ctx.typeName,
            index,
            parentVariantSignature: signature,
          }),
        );
      });
    } else if (signature.variant === 'Struct') {
      for (const field of signature.fields) {
        children.set(
          field.name,
          buildValueExample(registry, {
            typeName: field.typeName,
            depth: ctx.depth + 1,
            parentType: ctx.typeName,
            fieldName: field.name,
            parentVariantSignature: signature,
          }),
        );
      }
    }

    // Unit variants are always mutable (no fields to construct); empty child
    // sets are mutable too (upstream `determine_signature_mutability`).
    const statuses = [...children.values()].map((c) => c.mutability);
    const mutability: Mutability =
      signature.variant === 'Unit' || statuses.length === 0
        ? 'Mutable'
        : aggregateMutability(statuses);

    // Variants that cannot be fully constructed get no example at all.
    const example =
      mutability === 'Mutable'
        ? applyOptionTransformation(
            buildVariantExample(signature, names[0]!, children),
            names[0]!,
            ctx.typeName,
          )
        : undefined;

    groups.push({ signature, names, example, mutability });
  }

  // Select default example - knowledge first, then preferred variant example.
  let defaultExample: Example | undefined;
  if (knowledge.action === 'use-example-and-recurse') {
    defaultExample = jsonExample(knowledge.example);
  } else {
    defaultExample = selectPreferredExample(groups);
  }
  if (defaultExample === undefined) {
    throw new TypeGuideError(
      `Enum ${ctx.typeName} has no valid example: no knowledge and no mutable variants`,
    );
  }

  return {
    example: defaultExample,
    mutability: aggregateMutability(groups.map((g) => g.mutability)),
  };
}

function groupVariantsBySignature(variants: readonly VariantKind[]): [VariantSignature, string[]][] {
  const byKey = new Map<string, { signature: VariantSignature; names: string[] }>();
  for (const variant of variants) {
    const key = variantSignatureKey(variant.signature);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.names.push(variant.variantName);
    } else {
      byKey.set(key, { signature: variant.signature, names: [variant.variantName] });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => compareVariantSignatures(a.signature, b.signature))
    .map((g) => [g.signature, g.names]);
}

/**
 * Build a complete example for a variant with all its fields, before any
 * `Option` transformation (upstream `build_variant_example`).
 */
function buildVariantExample(
  signature: VariantSignature,
  variantName: string,
  children: ReadonlyMap<string, TypeExample>,
): Example {
  const short = variantShortName(variantName);
  switch (signature.variant) {
    case 'Unit':
      return jsonExample(short);
    case 'Tuple': {
      const values: Json[] = [];
      for (let index = 0; index < signature.types.length; index++) {
        const child = children.get(String(index));
        values.push(exampleToValue(child?.example ?? NOT_APPLICABLE));
      }
      // Single-element tuples are not wrapped in arrays - BRP expects the
      // direct value format for mutations.
      return jsonExample(
        values.length === 1 ? { [short]: values[0]! } : { [short]: values },
      );
    }
    case 'Struct': {
      const fields: Record<string, Json> = {};
      for (const key of [...children.keys()].sort()) {
        fields[key] = exampleToValue(children.get(key)!.example);
      }
      return jsonExample({ [short]: fields });
    }
  }
}

/**
 * Apply `Option<T>` transformation if needed: `{"Some": value}` → `value`,
 * `"None"` → explicit none (upstream `apply_option_transformation`).
 * Bevy's BRP collapses Option nesting via the wrap-unwrap pattern.
 */
function applyOptionTransformation(
  example: Example,
  variantName: string,
  enumType: string,
): Example {
  if (!(enumType.startsWith(OPTION_PREFIX) && enumType.endsWith('>'))) return example;

  switch (variantShortName(variantName)) {
    case 'None':
      return { kind: 'option-none' };
    case OPTION_SOME_FIELD: {
      if (
        example.kind === 'json' &&
        typeof example.value === 'object' &&
        example.value !== null &&
        !Array.isArray(example.value) &&
        OPTION_SOME_FIELD in example.value
      ) {
        return jsonExample(example.value[OPTION_SOME_FIELD]);
      }
      return example;
    }
    default:
      return example;
  }
}

/**
 * Select the preferred example from the variant groups (upstream
 * `select_preferred_example`): a non-unit mutable variant first (rich
 * examples), then any mutable variant. Groups without examples cannot be
 * fully constructed and are skipped.
 */
function selectPreferredExample(groups: readonly VariantGroup[]): Example | undefined {
  const nonUnit = groups.find((g) => g.signature.variant !== 'Unit' && g.example !== undefined);
  const any = nonUnit ?? groups.find((g) => g.example !== undefined);
  return any?.example;
}
