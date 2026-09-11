/**
 * Mutation-path construction for the Bevy type guides.
 *
 * Faithful port of the upstream `bevy_brp_mcp` 0.22.3 mutation-path builder,
 * upstream commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`, MIT licensed
 * (see THIRD_PARTY_NOTICES.md). Mapped files:
 * - `mutation_path_builder/path_builder.rs`        → `recurseMutationPaths` / non-enum builder
 * - `mutation_path_builder/enum_builder/*`         → `processEnum` and helpers
 * - `mutation_path_builder/type_kind_builder/*`    → `collectChildren` / `assembleFromChildren`
 * - `mutation_path_builder/recursion_context.rs`   → `RecursionContext`
 * - `mutation_path_builder/path_kind.rs`           → `PathKind` + descriptions
 * - `mutation_path_builder/mutation_path_internal.rs`, `mutation_path_external.rs`
 *                                                  → `MutationPathInternal` / `toExternalMutationPath`
 * - `mutation_path_builder/not_mutable_reason.rs`  → `NotMutableReason` + JSON/Display forms
 * - `mutation_path_builder/support.rs`             → chain collection/assembly helpers
 * - `mutation_path_builder/option_classification.rs`, `constants.rs`
 *
 * Upstream models "cannot be mutated" as an `Err(NotMutableReason)` that a
 * single choke point (`recurse_mutation_paths`) converts into a `NotMutable`
 * path; here that is a thrown `NotMutableSignal` caught at the same boundary.
 * Genuine schema/processing errors stay `TypeGuideError` and fail the whole
 * type guide (upstream `BuilderError::System`).
 */
import type {
  Example,
  Json,
  Mutability,
  Registry,
  TypeKind,
  VariantName,
  VariantSignature,
} from './model.js';
import {
  MAX_TYPE_RECURSION_DEPTH,
  NOT_APPLICABLE,
  aggregateMutability,
  compareVariantSignatures,
  exampleToValue,
  jsonExample,
  parseTypeKind,
  TypeGuideError,
  variantShortName,
  variantSignatureKey,
} from './model.js';
import {
  displayName,
  extractFieldType,
  getField,
  getFieldArray,
  getProperties,
  isHandle,
  parseEnumVariants,
  shortName,
} from './schema-info.js';
import type { VariantKind } from './schema-info.js';
import { getKnowledge, type KnowledgeKey, type TypeKnowledgeEntry } from './type-knowledge.js';

/** Where a node sits in its parent type (upstream `path_kind.rs` `PathKind`). */
type PathKind =
  | { readonly kind: 'root-value'; readonly typeName: string }
  | {
      readonly kind: 'struct-field';
      readonly fieldName: string;
      readonly typeName: string;
      readonly parentType: string;
    }
  | {
      readonly kind: 'indexed-element';
      readonly index: number;
      readonly typeName: string;
      readonly parentType: string;
    }
  | {
      readonly kind: 'array-element';
      readonly index: number;
      readonly typeName: string;
      readonly parentType: string;
    };

/** Wire spelling of a path kind (upstream serde: variant name string). */
function pathKindWire(pathKind: PathKind): string {
  switch (pathKind.kind) {
    case 'root-value':
      return 'RootValue';
    case 'struct-field':
      return 'StructField';
    case 'indexed-element':
      return 'IndexedElement';
    case 'array-element':
      return 'ArrayElement';
  }
}

function pathKindTypeName(pathKind: PathKind): string {
  return pathKind.typeName;
}

/** Path segment contributed by a path kind (upstream `path_kind_to_segment`). */
function pathKindSegment(pathKind: PathKind): string {
  switch (pathKind.kind) {
    case 'root-value':
      return '';
    case 'struct-field':
      return `.${pathKind.fieldName}`;
    case 'indexed-element':
      return `.${pathKind.index}`;
    case 'array-element':
      return `[${pathKind.index}]`;
  }
}

/** HashMap key for a child's example (upstream `to_mutation_path_descriptor`). */
function descriptorOf(pathKind: PathKind): string {
  switch (pathKind.kind) {
    case 'root-value':
      return '';
    case 'struct-field':
      return pathKind.fieldName;
    case 'indexed-element':
    case 'array-element':
      return String(pathKind.index);
  }
}

/** Type-kind terminology for diagnostics (upstream `TypeKind::child_terminology`). */
function childTerminology(kind: TypeKind): string {
  switch (kind) {
    case 'Struct':
      return 'fields';
    case 'Enum':
      return 'variants';
    case 'Map':
      return 'entries';
    case 'Array':
    case 'List':
    case 'Set':
    case 'Tuple':
    case 'TupleStruct':
      return 'elements';
    case 'Value':
      return 'components';
  }
}

// ===== Option classification (upstream `option_classification.rs`) =====

const OPTION_PREFIX = 'core::option::Option<';

/** Inner type when `typeName` is `core::option::Option<Inner>`, else undefined. */
function optionInner(typeName: string): string | undefined {
  if (!typeName.startsWith(OPTION_PREFIX) || !typeName.endsWith('>')) return undefined;
  return typeName.slice(OPTION_PREFIX.length, -1);
}

// ===== Not-mutable reasons (upstream `not_mutable_reason.rs`) =====

/** Structured reason why a path cannot (fully) be mutated. */
type NotMutableReason =
  | {
      readonly kind: 'immutable-handle';
      readonly containerType: string;
      readonly elementType: string;
    }
  | { readonly kind: 'not-in-registry'; readonly typeName: string }
  | { readonly kind: 'recursion-limit'; readonly typeName: string }
  | { readonly kind: 'complex-collection-key'; readonly typeName: string }
  | { readonly kind: 'immutable-children'; readonly parentType: string }
  | { readonly kind: 'no-example-available'; readonly typeName: string }
  | {
      readonly kind: 'partial-child-mutability';
      readonly parentType: string;
      readonly message: string;
      readonly mutable: readonly string[];
      readonly notMutable: readonly string[];
      readonly partiallyMutable: readonly string[];
    };

/** Human-readable form (upstream `Display for NotMutableReason`). */
function notMutableReasonText(reason: NotMutableReason): string {
  switch (reason.kind) {
    case 'immutable-handle':
      return `\`${reason.containerType}\` is a TupleStruct wrapper around \`${reason.elementType}\` which lacks the \`ReflectDeserialize\` type data required for mutation`;
    case 'not-in-registry':
      return `\`${reason.typeName}\` not found in schema registry`;
    case 'recursion-limit':
      return `\`${reason.typeName}\` analysis exceeded maximum recursion depth`;
    case 'complex-collection-key':
      return `HashMap \`${reason.typeName}\` has complex (enum/struct) keys that cannot be mutated through BRP - JSON requires string keys but complex types cannot currently be used with HashMap or HashSet`;
    case 'immutable-children':
      return `\`${reason.parentType}\` has no mutable child paths`;
    case 'no-example-available':
      return `\`${reason.typeName}\` is registered in the schema but has no discoverable example value available for mutations. If you look up the type definition yourself you may be able to use it to mutate this type directly.`;
    case 'partial-child-mutability':
      return `\`${reason.parentType}\` has partial child mutability - some children can be mutated, others cannot`;
  }
}

/** JSON form attached to `path_info.mutability_reason` (upstream `From<&NotMutableReason>`). */
function notMutableReasonJson(reason: NotMutableReason): Json {
  if (reason.kind !== 'partial-child-mutability') {
    return notMutableReasonText(reason);
  }
  const out: Record<string, Json> = { message: reason.message };
  if (reason.mutable.length > 0) out['mutable'] = [...reason.mutable];
  if (reason.notMutable.length > 0) out['not_mutable'] = [...reason.notMutable];
  if (reason.partiallyMutable.length > 0) {
    out['partially_mutable'] = [...reason.partiallyMutable];
  }
  return out;
}

/**
 * Categorize (path, status) issues into the deduplicated structured reason
 * (upstream `NotMutableReason::from_partial_mutability`): paths with
 * conflicting statuses across variants are listed as `partially_mutable`.
 */
function partialMutabilityReason(
  parentType: string,
  issues: readonly { readonly path: string; readonly mutability: Mutability }[],
  message: string,
): NotMutableReason {
  const statuses = new Map<string, Set<Mutability>>();
  for (const issue of issues) {
    const set = statuses.get(issue.path) ?? new Set<Mutability>();
    set.add(issue.mutability);
    statuses.set(issue.path, set);
  }

  const mutable: string[] = [];
  const notMutable: string[] = [];
  const partiallyMutable: string[] = [];
  for (const path of [...statuses.keys()].sort()) {
    const set = statuses.get(path)!;
    if (set.size > 1) {
      partiallyMutable.push(path);
    } else {
      const status = [...set][0]!;
      if (status === 'Mutable') mutable.push(path);
      else if (status === 'NotMutable') notMutable.push(path);
      else partiallyMutable.push(path);
    }
  }

  return {
    kind: 'partial-child-mutability',
    parentType,
    message,
    mutable,
    notMutable,
    partiallyMutable,
  };
}

// ===== Root examples and example groups (upstream external types) =====

/**
 * Root example for a path nested in an enum: constructible with a value, or
 * unavailable with a reason (upstream `RootExample`, untagged).
 */
type RootExample = { readonly example: Json } | { readonly unavailableReason: string };

/** One signature-grouped variant entry in an enum's `examples` array (upstream `ExampleGroup`). */
export interface ExampleGroup {
  readonly applicableVariants: readonly VariantName[];
  /** Omitted for variants that cannot be fully constructed. */
  readonly example?: Json;
  readonly signature: VariantSignature;
  readonly mutability: Mutability;
}

/** Wire serialization of a variant signature (upstream serde external tagging). */
function signatureToJson(signature: VariantSignature): Json {
  switch (signature.variant) {
    case 'Unit':
      return 'Unit';
    case 'Tuple':
      return { Tuple: [...signature.types] };
    case 'Struct':
      return { Struct: signature.fields.map((f) => [f.name, f.typeName]) };
  }
}

// ===== Internal path representation (upstream `mutation_path_internal.rs`) =====

/**
 * Example payload of one internal path: a simple value, or an enum root with
 * its signature groups plus the value parents use when assembling.
 */
export type PathExample =
  | { readonly kind: 'simple'; readonly example: Example }
  | { readonly kind: 'enum-root'; readonly groups: readonly ExampleGroup[]; readonly forParent: Example };

/** Enum-nesting data attached to any path below an enum variant (upstream `EnumPathInfo`). */
interface EnumPathInfo {
  readonly variantChain: readonly VariantName[];
  readonly applicableVariants: VariantName[];
  rootExample?: RootExample;
}

/** Internal mutation path under construction. */
interface MutationPathInternal {
  example: PathExample;
  mutationPath: string;
  /** Display (knowledge-simplified) type name (upstream `type_name.display_name()`). */
  typeName: string;
  pathKind: PathKind;
  mutability: Mutability;
  mutabilityReason?: NotMutableReason;
  enumPathInfo?: EnumPathInfo;
  depth: number;
  partialRootExamples?: Map<string, RootExample>;
}

/**
 * Thrown where upstream returns `Err(BuilderError::NotMutable)`; caught at the
 * `recurseMutationPaths` choke point and converted into a NotMutable path.
 */
class NotMutableSignal extends Error {
  constructor(public readonly reason: NotMutableReason) {
    super(notMutableReasonText(reason));
    this.name = 'NotMutableSignal';
  }
}

// ===== Recursion context (upstream `recursion_context.rs`) =====

interface RecursionContext {
  readonly pathKind: PathKind;
  readonly registry: Registry;
  readonly mutationPath: string;
  readonly pathAction: 'create' | 'skip';
  readonly variantChain: readonly VariantName[];
  readonly depth: number;
  readonly parentVariantSignature?: VariantSignature;
}

function newContext(pathKind: PathKind, registry: Registry): RecursionContext {
  return {
    pathKind,
    registry,
    mutationPath: '',
    pathAction: 'create',
    variantChain: [],
    depth: 0,
  };
}

function typeNameOf(ctx: RecursionContext): string {
  return pathKindTypeName(ctx.pathKind);
}

function requireRegistrySchema(ctx: RecursionContext): Json {
  const schema = ctx.registry.get(typeNameOf(ctx));
  if (schema === undefined) {
    throw new TypeGuideError(`Type ${typeNameOf(ctx)} not found in registry`);
  }
  return schema;
}

/**
 * Create the child context, enforcing the recursion depth limit exactly where
 * upstream does (upstream `create_recursion_context`): exceeding it raises the
 * child's `RecursionLimitExceeded` at the parent's choke point.
 */
function createChildContext(
  ctx: RecursionContext,
  pathKind: PathKind,
  childPathAction: 'create' | 'skip',
  overrides: {
    parentVariantSignature?: VariantSignature;
    pushVariant?: VariantName;
  } = {},
): RecursionContext {
  const depth = ctx.depth + 1;
  if (depth > MAX_TYPE_RECURSION_DEPTH) {
    throw new NotMutableSignal({ kind: 'recursion-limit', typeName: pathKind.typeName });
  }
  const variantChain = [...ctx.variantChain];
  if (overrides.pushVariant !== undefined) variantChain.push(overrides.pushVariant);
  return {
    pathKind,
    registry: ctx.registry,
    mutationPath: ctx.mutationPath + pathKindSegment(pathKind),
    // Once skipping, keep skipping for the entire subtree.
    pathAction: ctx.pathAction === 'skip' ? 'skip' : childPathAction,
    variantChain,
    depth,
    parentVariantSignature:
      overrides.parentVariantSignature ?? ctx.parentVariantSignature,
  };
}

// ===== Knowledge lookup (upstream `RecursionContext::find_knowledge`/`check_knowledge`) =====

type KnowledgeAction =
  | { readonly action: 'complete-with-example'; readonly example: Json }
  | { readonly action: 'use-example-and-recurse'; readonly example: Json }
  | { readonly action: 'missing' };

function findKnowledge(ctx: RecursionContext): TypeKnowledgeEntry | undefined {
  if (ctx.pathKind.kind === 'struct-field') {
    const key: KnowledgeKey = {
      kind: 'struct-field',
      structType: ctx.pathKind.parentType,
      fieldName: ctx.pathKind.fieldName,
    };
    const hit = getKnowledge(key);
    if (hit !== undefined) return hit;
    // Fall through to exact type match.
  } else if (
    ctx.pathKind.kind === 'indexed-element' &&
    ctx.parentVariantSignature !== undefined
  ) {
    if (ctx.parentVariantSignature.variant !== 'Tuple') {
      // Upstream architectural invariant: indexed children only ever carry
      // tuple signatures; anything else indicates a path-generation bug.
      throw new TypeGuideError(
        `IndexedElement path kind with ${ctx.parentVariantSignature.variant} variant signature for type ${ctx.pathKind.parentType}. This indicates a bug in path generation logic.`,
      );
    }
    const key: KnowledgeKey = {
      kind: 'enum-variant-signature',
      enumType: ctx.pathKind.parentType,
      signature: ctx.parentVariantSignature,
      index: ctx.pathKind.index,
    };
    const hit = getKnowledge(key);
    if (hit !== undefined) return hit;
    // Fall through to exact type match.
  }
  return getKnowledge({ kind: 'exact', typeName: typeNameOf(ctx) });
}

function checkKnowledge(ctx: RecursionContext): KnowledgeAction {
  const entry = findKnowledge(ctx);
  if (entry === undefined) return { action: 'missing' };
  if (entry.kind === 'treat-as-root-value') {
    return { action: 'complete-with-example', example: entry.example };
  }
  return { action: 'use-example-and-recurse', example: entry.example };
}

// ===== Type-kind builders (upstream `type_kind_builder/*`) =====

/** Default element count when an array size cannot be parsed from its name. */
const DEFAULT_ARRAY_EXAMPLE_LENGTH = 2;

/** Repository-owned cap on materialized `[T; N]` example arrays (value-builder
 * keeps the same bound); larger declared sizes fall back to the default. */
const MAX_ARRAY_EXAMPLE_LENGTH = 1024;

/** Extract `[T; N]` size from a type name (upstream `extract_array_size`).
 * Upstream parses into `usize`; an overflowing literal fails the parse and
 * falls back to the default length — `Number.isSafeInteger` is the closest
 * JS equivalent of that bound. The cap bounds the materialized example:
 * unlike upstream, `Array.from` would really allocate `size` elements. */
function extractArraySize(typeName: string): number | undefined {
  const semi = typeName.lastIndexOf('; ');
  const close = typeName.lastIndexOf(']');
  if (semi === -1 || close === -1 || semi + 2 > close) return undefined;
  const sizeStr = typeName.slice(semi + 2, close);
  if (!/^\d+$/.test(sizeStr)) return undefined;
  const size = Number(sizeStr);
  return Number.isSafeInteger(size) && size <= MAX_ARRAY_EXAMPLE_LENGTH ? size : undefined;
}

/** Complex (array/object) values cannot be map keys or set elements. */
function isComplexValue(value: Json): boolean {
  return Array.isArray(value) || (typeof value === 'object' && value !== null);
}

/**
 * Collect child path kinds for a non-enum node (upstream each builder's
 * `collect_children`). Order follows the registry schema's own field order.
 */
function collectChildren(kind: TypeKind, ctx: RecursionContext): readonly PathKind[] {
  const schema = requireRegistrySchema(ctx);

  switch (kind) {
    case 'Struct': {
      // Missing/empty properties is valid (marker structs).
      const properties = getProperties(schema);
      if (properties === undefined) return [];
      const children: PathKind[] = [];
      for (const [fieldName, fieldSchema] of Object.entries(properties)) {
        const fieldType = extractFieldType(fieldSchema);
        if (fieldType === undefined) {
          throw new TypeGuideError(
            `Failed to extract type for field '${fieldName}' in struct '${typeNameOf(ctx)}'`,
          );
        }
        children.push({
          kind: 'struct-field',
          fieldName,
          typeName: fieldType,
          parentType: typeNameOf(ctx),
        });
      }
      return children;
    }
    case 'Tuple':
    case 'TupleStruct': {
      const prefixItems = getFieldArray(schema, 'prefixItems');
      if (prefixItems === undefined) return []; // Empty tuple (unit type)
      const children: PathKind[] = [];
      prefixItems.forEach((elementSchema, index) => {
        const elementType = extractFieldType(elementSchema);
        if (elementType === undefined) {
          throw new TypeGuideError(
            `Failed to extract type for element ${index} in tuple '${typeNameOf(ctx)}'`,
          );
        }
        children.push({
          kind: 'indexed-element',
          index,
          typeName: elementType,
          parentType: typeNameOf(ctx),
        });
      });
      return children;
    }
    case 'Array':
    case 'List': {
      const label = kind === 'Array' ? 'array' : 'list';
      const elementType = extractFieldType(getField(schema, 'items') ?? null);
      if (elementType === undefined) {
        throw new TypeGuideError(
          `Failed to extract element type from schema for ${label}: ${typeNameOf(ctx)}`,
        );
      }
      // Only the first element is recursed for efficiency.
      return [
        {
          kind: 'array-element',
          index: 0,
          typeName: elementType,
          parentType: typeNameOf(ctx),
        },
      ];
    }
    case 'Map': {
      const keyType = extractFieldType(getField(schema, 'keyType') ?? null);
      if (keyType === undefined) {
        throw new TypeGuideError(
          `Failed to extract key type from schema for type: ${typeNameOf(ctx)}`,
        );
      }
      const valueType = extractFieldType(getField(schema, 'valueType') ?? null);
      if (valueType === undefined) {
        throw new TypeGuideError(
          `Failed to extract value type from schema for type: ${typeNameOf(ctx)}`,
        );
      }
      return [
        { kind: 'struct-field', fieldName: 'key', typeName: keyType, parentType: typeNameOf(ctx) },
        {
          kind: 'struct-field',
          fieldName: 'value',
          typeName: valueType,
          parentType: typeNameOf(ctx),
        },
      ];
    }
    case 'Set': {
      const itemType = extractFieldType(getField(schema, 'items') ?? null);
      if (itemType === undefined) {
        throw new TypeGuideError(
          `Failed to extract item type from schema for type: ${typeNameOf(ctx)}`,
        );
      }
      return [
        {
          kind: 'struct-field',
          fieldName: 'items',
          typeName: itemType,
          parentType: typeNameOf(ctx),
        },
      ];
    }
    case 'Value':
      return []; // Leaf type - no children
    case 'Enum':
      return []; // unreachable; enums dispatch to processEnum
  }
}

/**
 * Assemble a parent value from child examples (upstream each builder's
 * `assemble_from_children`). Throws `NotMutableSignal` for the failures
 * upstream models as `BuilderError::NotMutable` (Handle wrappers, complex
 * collection keys, leaf types without knowledge).
 */
function assembleFromChildren(
  kind: TypeKind,
  ctx: RecursionContext,
  children: ReadonlyMap<string, Example>,
): Json {
  switch (kind) {
    case 'Struct': {
      if (children.size === 0) return {}; // Marker struct
      // Sorted keys for deterministic field ordering; only present children.
      const obj: Record<string, Json> = {};
      for (const key of [...children.keys()].sort()) {
        obj[key] = exampleToValue(children.get(key)!);
      }
      return obj;
    }
    case 'Tuple':
    case 'TupleStruct': {
      const schema = requireRegistrySchema(ctx);
      const elements =
        getFieldArray(schema, 'prefixItems')
          ?.map((item) => extractFieldType(item))
          .filter((t): t is string => t !== undefined) ?? [];
      if (elements.length === 1 && isHandle(elements[0]!)) {
        throw new NotMutableSignal({
          kind: 'immutable-handle',
          containerType: typeNameOf(ctx),
          elementType: elements[0]!,
        });
      }
      const items: Json[] = [];
      for (let index = 0; index < elements.length; index++) {
        const example = children.get(String(index));
        items.push(example === undefined ? null : exampleToValue(example));
      }
      // Single-field tuple structs are unwrapped by BRP.
      if (items.length === 1) return items[0]!;
      if (items.length === 0) return null;
      return items;
    }
    case 'Array': {
      const example = children.get('0');
      if (example === undefined) {
        throw new TypeGuideError(
          `Protocol violation: Array ${typeNameOf(ctx)} missing element at index 0`,
        );
      }
      const size = extractArraySize(typeNameOf(ctx)) ?? DEFAULT_ARRAY_EXAMPLE_LENGTH;
      return Array.from({ length: size }, () => exampleToValue(example));
    }
    case 'List': {
      const example = children.get('0');
      if (example === undefined) {
        throw new TypeGuideError(
          `Protocol violation: List ${typeNameOf(ctx)} missing element at index 0`,
        );
      }
      return [exampleToValue(example)];
    }
    case 'Map': {
      const key = children.get('key');
      const value = children.get('value');
      if (key === undefined || value === undefined) {
        throw new TypeGuideError(
          `Protocol violation: Map type ${typeNameOf(ctx)} missing required key/value child example`,
        );
      }
      const keyValue = exampleToValue(key);
      if (isComplexValue(keyValue)) {
        throw new NotMutableSignal({ kind: 'complex-collection-key', typeName: typeNameOf(ctx) });
      }
      return { [mapKeyString(keyValue)]: exampleToValue(value) };
    }
    case 'Set': {
      const item = children.get('items');
      if (item === undefined) {
        throw new TypeGuideError(
          `Protocol violation: Set type ${typeNameOf(ctx)} missing required 'items' child example`,
        );
      }
      const itemValue = exampleToValue(item);
      if (isComplexValue(itemValue)) {
        throw new NotMutableSignal({ kind: 'complex-collection-key', typeName: typeNameOf(ctx) });
      }
      return [itemValue, itemValue];
    }
    case 'Value':
      throw new NotMutableSignal({ kind: 'no-example-available', typeName: typeNameOf(ctx) });
    case 'Enum':
      return null; // unreachable; enums dispatch to processEnum
  }
}

function mapKeyString(key: Json): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'number' || typeof key === 'boolean') return String(key);
  if (key === null) return 'null';
  throw new TypeGuideError(
    `Unexpected complex key type after complexity check: ${JSON.stringify(key)}`,
  );
}

/** Maps/Sets recurse for examples but never expose child paths. */
function childPathAction(kind: TypeKind): 'create' | 'skip' {
  return kind === 'Map' || kind === 'Set' ? 'skip' : 'create';
}

// ===== Shared support helpers (upstream `support.rs`) =====

/** Chain-keyed map key (variant names contain `::`, so join on NUL). */
function chainKey(chain: readonly string[]): string {
  return chain.join('\u0000');
}

/** Rust `Vec<String>` ordering: element-wise, then by length. */
function compareChains(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** A child's chain is compatible when it is a prefix of the target chain. */
function isVariantChainCompatible(child: MutationPathInternal, chain: readonly string[]): boolean {
  if (child.enumPathInfo === undefined) return true; // Non-enum children always compatible
  const childChain = child.enumPathInfo.variantChain;
  if (childChain.length > chain.length) return false;
  return childChain.every((name, i) => name === chain[i]);
}

/** Extract the value a child contributes for a target chain (upstream `extract_child_value_for_chain`). */
function extractChildValueForChain(
  child: MutationPathInternal,
  chain: readonly string[] | undefined,
): Example {
  const fallback = () => pathExampleForParent(child.example);
  if (chain === undefined) return fallback();
  const partials = child.partialRootExamples;
  if (partials === undefined) return fallback();

  const exact = partials.get(chainKey(chain));
  const fromExact = rootExampleValue(exact);
  if (fromExact !== undefined) return jsonExample(fromExact);

  // For enum children: find a mutable (Available) nested variant, sorted by chain.
  const nested = [...partials.entries()]
    .map(([key, rootExample]) => ({ key: key.split('\u0000'), rootExample }))
    .filter((entry) => entry.key.length === chain.length + 1 && chain.every((v, i) => entry.key[i] === v))
    .sort((a, b) => compareChains(a.key, b.key));
  for (const entry of nested) {
    const value = rootExampleValue(entry.rootExample);
    if (value !== undefined) return jsonExample(value);
  }
  return fallback();
}

/** Non-null `Available` example value, or undefined (null values are skipped). */
function rootExampleValue(rootExample: RootExample | undefined): Json | undefined {
  if (rootExample === undefined || !('example' in rootExample)) return undefined;
  return rootExample.example === null ? undefined : rootExample.example;
}

/** The value a path contributes to parent assembly (upstream `PathExample::for_parent`). */
function pathExampleForParent(example: PathExample): Example {
  return example.kind === 'simple' ? example.example : example.forParent;
}

/**
 * Collect direct-children values compatible with a variant chain
 * (upstream `support::collect_children_for_chain`).
 */
function collectChildrenForChain(
  childPaths: readonly MutationPathInternal[],
  ctx: RecursionContext,
  targetChain: readonly string[] | undefined,
): Map<string, Example> {
  const out = new Map<string, Example>();
  for (const child of childPaths) {
    if (child.depth !== ctx.depth + 1) continue; // direct children only
    if (targetChain !== undefined && !isVariantChainCompatible(child, targetChain)) continue;
    if (child.mutability === 'NotMutable') continue;
    out.set(descriptorOf(child.pathKind), extractChildValueForChain(child, targetChain));
  }
  return out;
}

/** Assemble a struct object from children, sorted keys (upstream `assemble_struct_from_children`). */
function assembleStructFromChildren(children: ReadonlyMap<string, Example>): Json {
  const obj: Record<string, Json> = {};
  for (const key of [...children.keys()].sort()) {
    obj[key] = exampleToValue(children.get(key)!);
  }
  return obj;
}

/** Populate `root_example` for paths whose chain matches a partial (upstream `populate_root_examples_from_partials`). */
function populateRootExamplesFromPartials(
  paths: MutationPathInternal[],
  partials: ReadonlyMap<string, RootExample>,
): void {
  for (const path of paths) {
    const info = path.enumPathInfo;
    if (info !== undefined && info.variantChain.length > 0) {
      const rootExample = partials.get(chainKey(info.variantChain));
      if (rootExample !== undefined) info.rootExample = rootExample;
    }
  }
}

/**
 * Wrap an example with availability status, propagating hierarchical
 * unavailability (upstream `wrap_example_with_availability`).
 */
function wrapExampleWithAvailability(
  example: Example,
  children: readonly MutationPathInternal[],
  chain: readonly string[],
  parentUnavailableReason: string | undefined,
): RootExample {
  let unavailableReason = parentUnavailableReason;
  if (unavailableReason === undefined) {
    for (const child of children) {
      const rootExample = child.partialRootExamples?.get(chainKey(chain));
      if (rootExample !== undefined && 'unavailableReason' in rootExample) {
        unavailableReason = rootExample.unavailableReason;
        break;
      }
    }
  }
  return unavailableReason !== undefined
    ? { unavailableReason }
    : { example: exampleToValue(example) };
}

/** Unique variant chains from direct children's partials (upstream `child_variant_chains`). */
function childVariantChains(children: readonly MutationPathInternal[], depth: number): string[][] {
  const chains = new Set<string>();
  for (const child of children) {
    if (child.depth !== depth + 1) continue;
    for (const key of child.partialRootExamples?.keys() ?? []) chains.add(key);
  }
  return [...chains].map((key) => key.split('\u0000'));
}

// ===== Parent mutability (upstream `determine_parent_mutability`) =====

function determineParentMutability(
  ctx: RecursionContext,
  childPaths: readonly MutationPathInternal[],
): { mutability: Mutability; reason?: NotMutableReason } {
  const schema = ctx.registry.get(typeNameOf(ctx)) ?? null;
  const typeKind = parseTypeKind(schema);
  const statuses = childPaths.map((p) => p.mutability);
  const issues = childPaths.map((p) => ({ path: p.mutationPath, mutability: p.mutability }));

  // SPECIAL CASE: Maps/Sets require ALL children to be mutable for BRP.
  if ((typeKind === 'Map' || typeKind === 'Set') && statuses.some((s) => s === 'NotMutable')) {
    const collectionType = typeKind === 'Map' ? 'Maps' : 'Sets';
    return {
      mutability: 'NotMutable',
      reason: partialMutabilityReason(
        typeNameOf(ctx),
        issues,
        `${collectionType} require all ${childTerminology(typeKind)} to be mutable for BRP operations`,
      ),
    };
  }

  const mutability = aggregateMutability(statuses);
  if (mutability === 'PartiallyMutable') {
    return {
      mutability,
      reason: partialMutabilityReason(
        typeNameOf(ctx),
        issues,
        `Some ${childTerminology(typeKind)} are mutable while others are not`,
      ),
    };
  }
  if (mutability === 'NotMutable') {
    return {
      mutability,
      reason: { kind: 'immutable-children', parentType: typeNameOf(ctx) },
    };
  }
  return { mutability };
}

// ===== Path descriptions (upstream `path_kind.rs` + `mutation_path_internal.rs`) =====

/** Description suffix naming the variants a path lives in. */
function enumVariantSuffix(enumPathInfo: EnumPathInfo | undefined): string {
  if (enumPathInfo === undefined) return '';
  const variants = enumPathInfo.applicableVariants;
  if (variants.length === 0) return '';
  if (variants.length === 1) return ` within ${variants[0]!} variant`;
  return ` within '${variants.join(', ')}' variants`;
}

/** Exactly-one applicable variant whose short name matches the parent type. */
function singleVariantMatchingParent(
  pathKind: PathKind,
  enumPathInfo: EnumPathInfo | undefined,
): VariantName | undefined {
  if (enumPathInfo === undefined) return undefined;
  if (enumPathInfo.applicableVariants.length !== 1) return undefined;
  if (pathKind.kind === 'root-value') return undefined;
  const variant = enumPathInfo.applicableVariants[0]!;
  return shortName(pathKind.parentType) === variantShortName(variant) ? variant : undefined;
}

/** Human-readable description for a mutable path (upstream `PathKind::description`). */
function describePath(pathKind: PathKind, typeKind: TypeKind, enumPathInfo: EnumPathInfo | undefined): string {
  const integrated = singleVariantMatchingParent(pathKind, enumPathInfo);
  if (integrated !== undefined) {
    switch (pathKind.kind) {
      case 'struct-field':
        return `Mutate the ${pathKind.fieldName} field of ${integrated} variant`;
      case 'indexed-element':
        return `Mutate element ${pathKind.index} of ${integrated} variant`;
      case 'array-element':
        return `Mutate element [${pathKind.index}] of ${integrated} variant`;
      case 'root-value':
        return `Mutate the root value of ${integrated} variant`;
    }
  }
  if (
    pathKind.kind === 'indexed-element' &&
    pathKind.index === 0 &&
    optionInner(pathKind.parentType) !== undefined
  ) {
    // Option<T> element at index 0: BRP collapses Option wrapping.
    return `Mutate the ${shortName(pathKind.typeName)} value inside Some variant`;
  }
  return `${describeNormal(pathKind, typeKind)}${enumVariantSuffix(enumPathInfo)}`;
}

function describeNormal(pathKind: PathKind, typeKind: TypeKind): string {
  const kindSuffix = typeKind === 'Value' ? '' : ` ${typeKind.toLowerCase()}`;
  switch (pathKind.kind) {
    case 'root-value':
      return `Replace the entire ${shortName(pathKind.typeName)}${kindSuffix}`;
    case 'struct-field': {
      const inner = optionInner(pathKind.typeName);
      if (inner !== undefined) {
        return `Set ${pathKind.fieldName} to None or Some(${shortName(inner)})`;
      }
      return `Mutate the ${pathKind.fieldName} field of ${shortName(pathKind.parentType)}${kindSuffix}`;
    }
    case 'indexed-element':
      return `Mutate element ${pathKind.index} of ${shortName(pathKind.parentType)}${kindSuffix}`;
    case 'array-element':
      return `Mutate element [${pathKind.index}] of ${shortName(pathKind.parentType)}${kindSuffix}`;
  }
}

// ===== Internal path construction (upstream `build_mutation_path_internal` et al.) =====

function emptyInternal(ctx: RecursionContext): MutationPathInternal {
  return {
    example: { kind: 'simple', example: NOT_APPLICABLE },
    mutationPath: ctx.mutationPath,
    typeName: displayName(typeNameOf(ctx)),
    pathKind: ctx.pathKind,
    mutability: 'Mutable',
    depth: ctx.depth,
  };
}

function buildInternal(
  ctx: RecursionContext,
  example: PathExample,
  mutability: Mutability,
  mutabilityReason?: NotMutableReason,
  partialRootExamples?: Map<string, RootExample>,
): MutationPathInternal {
  const path: MutationPathInternal = {
    ...emptyInternal(ctx),
    example,
    mutability,
  };
  if (mutabilityReason !== undefined) path.mutabilityReason = mutabilityReason;
  if (partialRootExamples !== undefined) path.partialRootExamples = partialRootExamples;
  if (ctx.variantChain.length > 0) {
    path.enumPathInfo = {
      variantChain: [...ctx.variantChain],
      applicableVariants: [],
    };
  }
  return path;
}

function notMutablePath(ctx: RecursionContext, reason: NotMutableReason): MutationPathInternal {
  return buildInternal(ctx, { kind: 'simple', example: NOT_APPLICABLE }, 'NotMutable', reason);
}

/** Root paths of types implementing `Default` (upstream `has_default_for_root`). */
function hasDefaultForRoot(pathKind: PathKind, fieldSchema: Json): boolean {
  if (pathKind.kind !== 'root-value') return false;
  const reflectTypes = getFieldArray(fieldSchema, 'reflectTypes');
  return reflectTypes?.some((t) => t === 'Default') ?? false;
}

/** Spawn/insert guidance for Default-implementing roots (upstream `get_default_spawn_guidance`). */
function defaultSpawnGuidance(fieldSchema: Json): string {
  const reflectTypes = (getFieldArray(fieldSchema, 'reflectTypes') ?? []).filter(
    (t): t is string => typeof t === 'string',
  );
  const operation = reflectTypes.includes('Component')
    ? 'spawn'
    : reflectTypes.includes('Resource')
      ? 'insert'
      : 'spawn'; // Fallback for types that are neither Component nor Resource
  return ` However this type implements Default and accepts empty object {} for ${operation} or mutate operations on the root path`;
}

/** Description for any mutability status (upstream `resolve_description`). */
function resolveDescription(
  path: MutationPathInternal,
  typeKind: TypeKind,
  rootDefault: boolean,
  fieldSchema: Json,
): string {
  switch (path.mutability) {
    case 'PartiallyMutable': {
      const base = `This ${typeKind.toLowerCase()} path is partially mutable due to some of its ${childTerminology(typeKind)} not being mutable`;
      return rootDefault
        ? `${base}.${defaultSpawnGuidance(fieldSchema)}`
        : `${base}. No example is provided.`;
    }
    case 'NotMutable': {
      const base = `This ${typeKind.toLowerCase()} is not mutable`;
      if (path.pathKind.kind === 'root-value' && rootDefault) {
        return `${base}.${defaultSpawnGuidance(fieldSchema)}`;
      }
      return `${base}. No example is provided.`;
    }
    case 'Mutable':
      return describePath(path.pathKind, typeKind, path.enumPathInfo);
  }
}

/** Final example payload by mutability (upstream `resolve_path_example`). */
function resolvePathExample(path: MutationPathInternal, rootDefault: boolean): PathExample {
  switch (path.mutability) {
    case 'NotMutable':
      return { kind: 'simple', example: NOT_APPLICABLE };
    case 'PartiallyMutable':
      if (path.example.kind === 'enum-root') return path.example;
      return rootDefault
        ? { kind: 'simple', example: jsonExample({}) }
        : { kind: 'simple', example: NOT_APPLICABLE };
    case 'Mutable':
      return path.example;
  }
}

const ENUM_INSTRUCTIONS =
  'Current mutation path is nested within an enum variant. To mutate, first mutate path "" to the \'example\' value in \'path_info\', then this path.';

// ===== External conversion (upstream `into_mutation_path_external`) =====

/** Serialized mutation path as it appears in the tool's JSON response. */
export interface ExternalMutationPath {
  path: string;
  description: string;
  /** Present when the path carries a simple non-null example. */
  example?: Json;
  /** Present for enum root paths (signature-grouped variants). */
  examples?: Json;
  path_info: {
    path_kind: string;
    type: string;
    type_kind: TypeKind;
    mutability: 'mutable' | 'not_mutable' | 'partially_mutable';
    mutability_reason?: Json;
    applicable_variants?: readonly VariantName[];
    enum_instructions?: string;
    example?: Json;
    unavailable_reason?: string;
  };
}

const MUTABILITY_WIRE: Record<Mutability, 'mutable' | 'not_mutable' | 'partially_mutable'> = {
  Mutable: 'mutable',
  NotMutable: 'not_mutable',
  PartiallyMutable: 'partially_mutable',
};

function simpleExampleWire(example: PathExample): Json | undefined {
  if (example.kind !== 'simple') return undefined;
  const value = exampleToValue(example.example);
  return value === null ? undefined : value; // Null examples serialize to no field
}

function enumGroupsWire(example: PathExample): Json | undefined {
  if (example.kind !== 'enum-root') return undefined;
  return example.groups.map((group) => {
    const out: Record<string, Json> = {
      applicable_variants: [...group.applicableVariants],
    };
    if (group.example !== undefined) out['example'] = group.example;
    out['signature'] = signatureToJson(group.signature);
    out['mutability'] = MUTABILITY_WIRE[group.mutability];
    return out as unknown as Json;
  }) as unknown as Json;
}

/** Convert one internal path into its serialized external form. */
function toExternalMutationPath(
  path: MutationPathInternal,
  registry: Registry,
): ExternalMutationPath {
  // Schema lookup uses the DISPLAY name, exactly as upstream does.
  const fieldSchema = registry.get(path.typeName) ?? null;
  const typeKind = parseTypeKind(fieldSchema);
  const rootDefault = hasDefaultForRoot(path.pathKind, fieldSchema);

  const description = resolveDescription(path, typeKind, rootDefault, fieldSchema);
  const example = resolvePathExample(path, rootDefault);

  const pathInfo: ExternalMutationPath['path_info'] = {
    path_kind: pathKindWire(path.pathKind),
    type: path.typeName,
    type_kind: typeKind,
    mutability: MUTABILITY_WIRE[path.mutability],
  };
  if (path.mutabilityReason !== undefined) {
    pathInfo.mutability_reason = notMutableReasonJson(path.mutabilityReason);
  }

  // Enum-nesting metadata only for mutable/partially mutable paths.
  if (path.mutability === 'Mutable' || path.mutability === 'PartiallyMutable') {
    const info = path.enumPathInfo;
    if (info !== undefined) {
      if (info.applicableVariants.length > 0) {
        pathInfo.applicable_variants = [...info.applicableVariants];
      }
      if (info.rootExample !== undefined) {
        if ('example' in info.rootExample) {
          pathInfo.enum_instructions = ENUM_INSTRUCTIONS;
          pathInfo.example = info.rootExample.example;
        } else {
          pathInfo.unavailable_reason = info.rootExample.unavailableReason;
        }
      }
    }
  }

  const external: ExternalMutationPath = {
    path: path.mutationPath,
    description,
    path_info: pathInfo,
    // serde flatten emits path_example fields after the named struct fields.
    ...(simpleExampleWire(example) !== undefined
      ? { example: simpleExampleWire(example) }
      : {}),
    ...(example.kind === 'enum-root' ? { examples: enumGroupsWire(example) } : {}),
  };
  // The serialized wire omits null examples exactly like upstream serde, but
  // spawn/insert extraction still needs the full typed example (upstream keeps
  // the `PathExample` on `MutationPathExternal`); carry it in a side-table so
  // the external object stays wire-identical under JSON.stringify.
  INTERNAL_EXAMPLES.set(external, example);
  return external;
}

const INTERNAL_EXAMPLES = new WeakMap<ExternalMutationPath, PathExample>();

/** The full typed example of an external path (upstream `MutationPathExternal.path_example`). */
export function internalExampleOf(path: ExternalMutationPath): PathExample | undefined {
  return INTERNAL_EXAMPLES.get(path);
}

// ===== Non-enum builder (upstream `path_builder.rs` `MutationPathBuilder`) =====

interface ChildProcessingResult {
  allPaths: MutationPathInternal[];
  pathsToExpose: MutationPathInternal[];
  childExamples: Map<string, Example>;
}

function buildNotMutable(
  kind: TypeKind,
  ctx: RecursionContext,
): MutationPathInternal[] {
  // Registry membership is checked before anything else.
  if (!ctx.registry.has(typeNameOf(ctx))) {
    return [notMutablePath(ctx, { kind: 'not-in-registry', typeName: typeNameOf(ctx) })];
  }
  try {
    const knowledge = checkKnowledge(ctx);
    if (knowledge.action === 'complete-with-example') {
      return [
        buildInternal(ctx, { kind: 'simple', example: jsonExample(knowledge.example) }, 'Mutable'),
      ];
    }
    const knowledgeExample =
      knowledge.action === 'use-example-and-recurse' ? jsonExample(knowledge.example) : undefined;

    const children = processAllChildren(kind, ctx);
    const assembledValue = assembleFromChildren(kind, ctx, children.childExamples);
    const assembledExample = jsonExample(assembledValue);

    // Direct children by descriptor match (upstream filters the same way).
    const directChildren = children.allPaths.filter((p) =>
      children.childExamples.has(descriptorOf(p.pathKind)),
    );
    const partials = buildPartialRootExamples(kind, ctx, directChildren);

    const finalExample = knowledgeExample ?? assembledExample;
    const { mutability, reason } = determineParentMutability(ctx, children.allPaths);

    let exampleToUse: Example;
    switch (mutability) {
      case 'NotMutable':
        exampleToUse = NOT_APPLICABLE;
        break;
      case 'PartiallyMutable': {
        const mutableChildren = new Map<string, Example>();
        for (const [descriptor, example] of children.childExamples) {
          const childPath = children.allPaths.find(
            (p) => descriptorOf(p.pathKind) === descriptor && p.mutability === 'Mutable',
          );
          if (childPath !== undefined) mutableChildren.set(descriptor, example);
        }
        let assembled: Json;
        try {
          assembled = assembleFromChildren(kind, ctx, mutableChildren);
        } catch {
          assembled = null; // upstream unwrap_or_else(json!(null))
        }
        exampleToUse = jsonExample(assembled);
        break;
      }
      case 'Mutable':
        exampleToUse = finalExample;
        break;
    }

    if (mutability === 'NotMutable') {
      throw new NotMutableSignal(
        reason ?? { kind: 'immutable-children', parentType: typeNameOf(ctx) },
      );
    }

    return buildFinalResult(ctx, children.pathsToExpose, exampleToUse, mutability, reason, partials);
  } catch (error) {
    if (error instanceof NotMutableSignal) return [notMutablePath(ctx, error.reason)];
    throw error;
  }
}

function processAllChildren(kind: TypeKind, ctx: RecursionContext): ChildProcessingResult {
  const allPaths: MutationPathInternal[] = [];
  const pathsToExpose: MutationPathInternal[] = [];
  const childExamples = new Map<string, Example>();

  for (const pathKind of collectChildren(kind, ctx)) {
    const childContext = createChildContext(ctx, pathKind, childPathAction(kind));
    const childKey = descriptorOf(pathKind);
    const { paths, example } = processChild(childContext);
    childExamples.set(childKey, example);
    allPaths.push(...paths);
    if (childContext.pathAction === 'create') pathsToExpose.push(...paths);
  }

  return { allPaths, pathsToExpose, childExamples };
}

function processChild(childCtx: RecursionContext): {
  paths: MutationPathInternal[];
  example: Example;
} {
  // Child not in registry: a NotMutable child path, no recursion.
  if (childCtx.registry.get(typeNameOf(childCtx)) === undefined) {
    return {
      paths: [notMutablePath(childCtx, { kind: 'not-in-registry', typeName: typeNameOf(childCtx) })],
      example: NOT_APPLICABLE,
    };
  }
  const childKind = parseTypeKind(childCtx.registry.get(typeNameOf(childCtx))!);
  const paths = recurseMutationPaths(childKind, childCtx);
  const example = paths.length > 0 ? pathExampleForParent(paths[0]!.example) : NOT_APPLICABLE;
  return { paths, example };
}

/** Ascent-phase partial root examples for non-enum nodes (upstream `build_partial_root_examples`). */
function buildPartialRootExamples(
  kind: TypeKind,
  ctx: RecursionContext,
  childPaths: readonly MutationPathInternal[],
): Map<string, RootExample> | undefined {
  const schema = ctx.registry.get(typeNameOf(ctx)) ?? null;
  const typeKind = parseTypeKind(schema);

  // Maps/Sets with NotMutable children cannot have valid partial root examples.
  if (typeKind === 'Map' || typeKind === 'Set') {
    if (childPaths.some((p) => p.mutability === 'NotMutable')) return undefined;
  }

  const allChains = childVariantChains(childPaths, ctx.depth);
  if (allChains.length === 0) return undefined;

  const partials = new Map<string, RootExample>();
  for (const chain of allChains) {
    const examplesForChain = collectChildrenForChain(childPaths, ctx, chain);
    // Assembly failure at this level makes the whole node NotMutable.
    const assembledValue = assembleFromChildren(kind, ctx, examplesForChain);
    partials.set(
      chainKey(chain),
      wrapExampleWithAvailability(jsonExample(assembledValue), childPaths, chain, undefined),
    );
  }
  return partials;
}

function buildFinalResult(
  ctx: RecursionContext,
  pathsToExpose: MutationPathInternal[],
  exampleToUse: Example,
  parentStatus: Mutability,
  mutabilityReason: NotMutableReason | undefined,
  partialRootExamples: Map<string, RootExample> | undefined,
): MutationPathInternal[] {
  if (partialRootExamples !== undefined) {
    for (const child of pathsToExpose) {
      child.partialRootExamples = new Map(partialRootExamples);
    }
    populateRootExamplesFromPartials(pathsToExpose, partialRootExamples);
  }

  const root = buildInternal(
    ctx,
    { kind: 'simple', example: exampleToUse },
    parentStatus,
    mutabilityReason,
    partialRootExamples === undefined
      ? undefined
      : new Map(partialRootExamples),
  );

  if (ctx.pathAction === 'create') {
    return [root, ...pathsToExpose];
  }
  return [root]; // Skip mode: example available for parents, children not exposed
}

// ===== Enum builder (upstream `enum_builder/enum_path_builder.rs`) =====

/** Group schema variants by signature, deterministic order (upstream `group_variants_by_signature`). */
function groupVariantsBySignature(ctx: RecursionContext): [VariantSignature, VariantName[]][] {
  const schema = requireRegistrySchema(ctx);
  const variants: VariantKind[] = parseEnumVariants(schema, typeNameOf(ctx));
  const byKey = new Map<string, { signature: VariantSignature; names: VariantName[] }>();
  for (const variant of variants) {
    const key = variantSignatureKey(variant.signature);
    const existing = byKey.get(key);
    if (existing !== undefined) existing.names.push(variant.variantName);
    else byKey.set(key, { signature: variant.signature, names: [variant.variantName] });
  }
  return [...byKey.values()]
    .sort((a, b) => compareVariantSignatures(a.signature, b.signature))
    .map((g) => [g.signature, g.names]);
}

/** Select the preferred spawn example from groups (upstream `select_preferred_example`). */
export function selectPreferredExample(
  examples: readonly ExampleGroup[],
): Example | undefined {
  const nonUnit = examples.find(
    (eg) =>
      eg.signature.variant !== 'Unit' &&
      eg.example !== undefined &&
      eg.mutability === 'Mutable',
  );
  const any = nonUnit ?? examples.find((eg) => eg.example !== undefined && eg.mutability === 'Mutable');
  return any?.example === undefined ? undefined : jsonExample(any.example);
}

function processEnum(ctx: RecursionContext): MutationPathInternal[] {
  const variantGroups = groupVariantsBySignature(ctx);
  const { examples, childMutationPaths, partialRootExamples } =
    processSignatureGroups(variantGroups, ctx);

  const knowledge = checkKnowledge(ctx);
  if (knowledge.action === 'complete-with-example') {
    // Opaque enum: a single root path, immediately.
    const path = buildInternal(
      ctx,
      { kind: 'simple', example: jsonExample(knowledge.example) },
      'Mutable',
    );
    return [path];
  }

  const defaultExample =
    knowledge.action === 'use-example-and-recurse'
      ? jsonExample(knowledge.example)
      : selectPreferredExample(examples);
  if (defaultExample === undefined) {
    throw new TypeGuideError(
      `Enum ${typeNameOf(ctx)} has no valid example: no knowledge and no mutable variants`,
    );
  }

  return createEnumMutationPaths(ctx, examples, defaultExample, childMutationPaths, partialRootExamples);
}

interface ProcessChildrenResult {
  examples: ExampleGroup[];
  childMutationPaths: MutationPathInternal[];
  partialRootExamples: Map<string, RootExample>;
}

function processSignatureGroups(
  variantGroups: readonly [VariantSignature, VariantName[]][],
  ctx: RecursionContext,
): ProcessChildrenResult {
  const examples: ExampleGroup[] = [];
  const childMutationPaths: MutationPathInternal[] = [];

  for (const [signature, variantNames] of variantGroups) {
    // Fresh child examples per signature group (upstream avoids collisions).
    const childExamples = new Map<string, Example>();
    const signatureChildPaths: MutationPathInternal[] = [];

    for (const pathKind of createPathsForSignature(signature, ctx)) {
      const childPaths = processSignaturePath(
        pathKind,
        variantNames,
        signature,
        ctx,
        childExamples,
      );
      signatureChildPaths.push(...childPaths);
    }

    const mutability = determineSignatureMutability(signature, signatureChildPaths, ctx);
    const representative = variantNames[0]!;
    const example =
      mutability === 'NotMutable' || mutability === 'PartiallyMutable'
        ? undefined // Variants that cannot be fully constructed get no example.
        : buildVariantExample(signature, representative, childExamples, typeNameOf(ctx));

    examples.push({
      applicableVariants: [...variantNames],
      signature,
      example: example === undefined ? undefined : exampleToValue(example),
      mutability,
    });
    childMutationPaths.push(...signatureChildPaths);
  }

  const partialRootExamples = buildEnumPartialRootExamples(
    variantGroups,
    examples,
    childMutationPaths,
    ctx,
  );
  return { examples, childMutationPaths, partialRootExamples };
}

function createPathsForSignature(
  signature: VariantSignature,
  ctx: RecursionContext,
): readonly PathKind[] {
  switch (signature.variant) {
    case 'Unit':
      return [];
    case 'Tuple':
      return signature.types.map((typeName, index) => ({
        kind: 'indexed-element' as const,
        index,
        typeName,
        parentType: typeNameOf(ctx),
      }));
    case 'Struct':
      return signature.fields.map((field) => ({
        kind: 'struct-field' as const,
        fieldName: field.name,
        typeName: field.typeName,
        parentType: typeNameOf(ctx),
      }));
  }
}

function processSignaturePath(
  pathKind: PathKind,
  applicableVariants: readonly VariantName[],
  signature: VariantSignature,
  ctx: RecursionContext,
  childExamples: Map<string, Example>,
): MutationPathInternal[] {
  // Parent variant signature drives indexed-element knowledge lookups; the
  // representative variant extends the chain (upstream post-creation context
  // adjustments in `process_signature_path`).
  const childContext = createChildContext(ctx, pathKind, 'create', {
    parentVariantSignature: signature,
    pushVariant: applicableVariants[0],
  });

  const childSchema = requireRegistrySchema(childContext);
  const childKind = parseTypeKind(childSchema);
  const childPaths = recurseMutationPaths(childKind, childContext);

  // Track which variants make these child paths valid (direct children only).
  for (const childPath of childPaths) {
    const info = childPath.enumPathInfo;
    if (info !== undefined && info.variantChain.length === ctx.variantChain.length + 1) {
      info.applicableVariants.push(...applicableVariants);
    }
  }

  const childExample = childPaths[0]?.example
    ? pathExampleForParent(childPaths[0]!.example)
    : undefined;
  if (childExample === undefined) {
    throw new TypeGuideError(
      `Empty child_paths returned for descriptor ${descriptorOf(pathKind)}`,
    );
  }
  childExamples.set(descriptorOf(pathKind), childExample);

  return childPaths;
}

function determineSignatureMutability(
  signature: VariantSignature,
  signatureChildPaths: readonly MutationPathInternal[],
  ctx: RecursionContext,
): Mutability {
  if (signature.variant === 'Unit') return 'Mutable'; // No fields to construct
  const statuses = signatureChildPaths
    .filter((p) => p.depth === ctx.depth + 1)
    .map((p) => p.mutability);
  return statuses.length === 0 ? 'Mutable' : aggregateMutability(statuses);
}

/**
 * Build a complete example for a variant, applying the `Option<T>`
 * transformation (upstream `build_variant_example`).
 */
function buildVariantExample(
  signature: VariantSignature,
  variantName: VariantName,
  children: ReadonlyMap<string, Example>,
  enumType: string,
): Example {
  const short = variantShortName(variantName);
  let example: Example;
  switch (signature.variant) {
    case 'Unit':
      example = jsonExample(short);
      break;
    case 'Tuple': {
      const values: Json[] = [];
      for (let index = 0; index < signature.types.length; index++) {
        const child = children.get(String(index));
        values.push(exampleToValue(child ?? NOT_APPLICABLE));
      }
      // Single-element tuples are not wrapped in arrays (BRP direct value).
      example = jsonExample(
        values.length === 1 ? { [short]: values[0]! } : { [short]: values },
      );
      break;
    }
    case 'Struct':
      example = jsonExample({ [short]: assembleStructFromChildren(children) });
      break;
  }
  return applyOptionTransformation(example, variantName, enumType);
}

/** `{"Some": v}` → `v`, `"None"` → explicit none (upstream `apply_option_transformation`). */
function applyOptionTransformation(
  example: Example,
  variantName: VariantName,
  enumType: string,
): Example {
  if (optionInner(enumType) === undefined) return example;
  switch (variantShortName(variantName)) {
    case 'None':
      return { kind: 'option-none' };
    case 'Some': {
      if (
        example.kind === 'json' &&
        typeof example.value === 'object' &&
        example.value !== null &&
        !Array.isArray(example.value) &&
        'Some' in example.value
      ) {
        return jsonExample(example.value['Some']);
      }
      return example;
    }
    default:
      return example;
  }
}

/** Ascent-phase partial root examples for enum nodes (upstream `build_partial_root_examples`). */
function buildEnumPartialRootExamples(
  variantGroups: readonly [VariantSignature, VariantName[]][],
  enumExamples: readonly ExampleGroup[],
  childMutationPaths: readonly MutationPathInternal[],
  ctx: RecursionContext,
): Map<string, RootExample> {
  const partials = new Map<string, RootExample>();

  for (const [signature, variants] of variantGroups) {
    for (const variantName of variants) {
      const thisVariantChain = [...ctx.variantChain, variantName];

      const spawnExample =
        enumExamples.find((ex) => ex.applicableVariants.includes(variantName))?.example !==
        undefined
          ? jsonExample(
              enumExamples.find((ex) => ex.applicableVariants.includes(variantName))!.example!,
            )
          : (selectPreferredExample(enumExamples) ?? NOT_APPLICABLE);

      const variantMutability =
        enumExamples.find((ex) => ex.applicableVariants.includes(variantName))?.mutability ??
        'NotMutable';

      const variantUnavailableReason = analyzeVariantConstructibility(
        variantName,
        signature,
        variantMutability,
        childMutationPaths,
        ctx,
      );

      const nestedChains = childVariantChains(childMutationPaths, ctx.depth)
        .filter((chain) => startsWith(chain, thisVariantChain));

      for (const nestedChain of nestedChains) {
        const example = buildVariantExampleForChain(
          signature,
          variantName,
          childMutationPaths,
          nestedChain,
          ctx,
        );
        partials.set(
          chainKey(nestedChain),
          wrapExampleWithAvailability(
            example,
            childMutationPaths,
            nestedChain,
            variantUnavailableReason,
          ),
        );
      }

      const ownExample =
        nestedChains.length === 0
          ? spawnExample
          : buildVariantExampleForChain(
              signature,
              variantName,
              childMutationPaths,
              thisVariantChain,
              ctx,
            );
      partials.set(
        chainKey(thisVariantChain),
        wrapExampleWithAvailability(
          ownExample,
          childMutationPaths,
          thisVariantChain,
          variantUnavailableReason,
        ),
      );
    }
  }

  return partials;
}

function startsWith(chain: readonly string[], prefix: readonly string[]): boolean {
  return (
    chain.length >= prefix.length && prefix.every((name, i) => chain[i] === name)
  );
}

function buildVariantExampleForChain(
  signature: VariantSignature,
  variantName: VariantName,
  childMutationPaths: readonly MutationPathInternal[],
  variantChain: readonly string[],
  ctx: RecursionContext,
): Example {
  const children = collectChildrenForChain(childMutationPaths, ctx, variantChain);
  return buildVariantExample(signature, variantName, children, typeNameOf(ctx));
}

/**
 * Whether a variant can be constructed via BRP; returns the human-readable
 * unavailability reason when it cannot (upstream `analyze_variant_constructibility`).
 */
function analyzeVariantConstructibility(
  variantName: VariantName,
  signature: VariantSignature,
  mutability: Mutability,
  childPaths: readonly MutationPathInternal[],
  ctx: RecursionContext,
): string | undefined {
  if (signature.variant === 'Unit') return undefined; // Always constructible
  if (mutability === 'Mutable') return undefined;

  if (mutability === 'NotMutable') {
    return `Cannot construct ${variantShortName(variantName)} variant via BRP - all fields are non-mutable. This variant cannot be mutated via BRP.`;
  }

  // PartiallyMutable: collect problematic direct fields of this variant.
  const problematicFields: string[] = [];
  for (const p of childPaths) {
    if (p.depth !== ctx.depth + 1) continue;
    const info = p.enumPathInfo;
    if (info === undefined || info.variantChain.length === 0 || info.variantChain[0] !== variantName) {
      continue;
    }
    if (p.mutability !== 'NotMutable' && p.mutability !== 'PartiallyMutable') continue;

    const typeShort = shortName(p.typeName);
    let fieldLabel: string;
    switch (p.pathKind.kind) {
      case 'struct-field':
        fieldLabel = p.pathKind.fieldName;
        break;
      case 'indexed-element':
        fieldLabel =
          signature.variant === 'Tuple'
            ? `tuple element ${p.pathKind.index}`
            : `element ${p.pathKind.index}`;
        break;
      case 'array-element':
        fieldLabel = `array element ${p.pathKind.index}`;
        break;
      case 'root-value':
        fieldLabel = 'root';
        break;
    }
    const reasonDetail =
      p.mutability === 'PartiallyMutable'
        ? `contains non-mutable descendants (see '${typeShort}' mutation_paths for details)`
        : (p.mutabilityReason !== undefined
            ? notMutableReasonText(p.mutabilityReason)
            : 'unknown reason');
    problematicFields.push(`${fieldLabel} (${typeShort}): ${reasonDetail}`);
  }

  if (problematicFields.length === 0) return undefined;

  return (
    `Cannot construct ${variantShortName(variantName)} variant via BRP due to incomplete field data: ${problematicFields.join('; ')}. ` +
    `This variant's mutable fields can only be mutated if the entity is already set to this variant by your code.`
  );
}

/** Mutability reason for enum roots (upstream `build_enum_mutability_reason`). */
function buildEnumMutabilityReason(
  enumMutability: Mutability,
  enumExamples: readonly ExampleGroup[],
  typeName: string,
): NotMutableReason | undefined {
  if (enumMutability === 'PartiallyMutable') {
    const issues = enumExamples.flatMap((eg) =>
      eg.applicableVariants.map((variant) => ({ path: variant, mutability: eg.mutability })),
    );
    return partialMutabilityReason(
      typeName,
      issues,
      'Some variants are mutable while others are not',
    );
  }
  if (enumMutability === 'NotMutable') {
    return { kind: 'immutable-children', parentType: typeName };
  }
  return undefined;
}

function createEnumMutationPaths(
  ctx: RecursionContext,
  enumExamples: ExampleGroup[],
  defaultExample: Example,
  childMutationPaths: MutationPathInternal[],
  partialRootExamples: Map<string, RootExample>,
): MutationPathInternal[] {
  const enumMutability = aggregateMutability(enumExamples.map((eg) => eg.mutability));
  const mutabilityReason = buildEnumMutabilityReason(
    enumMutability,
    enumExamples,
    typeNameOf(ctx),
  );

  const root = buildInternal(
    ctx,
    { kind: 'enum-root', groups: enumExamples, forParent: defaultExample },
    enumMutability,
    mutabilityReason,
  );
  root.partialRootExamples = new Map(partialRootExamples);

  // Root-level enums propagate partials to their direct child paths.
  if (ctx.variantChain.length === 0) {
    for (const child of childMutationPaths) {
      child.partialRootExamples = new Map(partialRootExamples);
    }
    populateRootExamplesFromPartials(childMutationPaths, partialRootExamples);
  }

  return [root, ...childMutationPaths];
}

// ===== Public entry points (upstream `api.rs`) =====

/**
 * Build all mutation paths for a type (upstream `build_mutation_paths`).
 * Throws `TypeGuideError` for schema/processing failures; the guide converts
 * those into a per-type `error` result.
 */
export function buildMutationPaths(typeName: string, registry: Registry): ExternalMutationPath[] {
  const schema = registry.get(typeName);
  if (schema === undefined) {
    throw new TypeGuideError(`Type ${typeName} not found in registry`);
  }
  const typeKind = parseTypeKind(schema);
  const ctx = newContext({ kind: 'root-value', typeName }, registry);
  return recurseMutationPaths(typeKind, ctx).map((path) => toExternalMutationPath(path, registry));
}

/**
 * Single dispatch: build a node's paths, converting NotMutable signals into a
 * single NotMutable path (upstream `recurse_mutation_paths` choke point).
 */
function recurseMutationPaths(
  typeKind: TypeKind,
  ctx: RecursionContext,
): MutationPathInternal[] {
  if (typeKind === 'Enum') {
    try {
      return processEnum(ctx);
    } catch (error) {
      if (error instanceof NotMutableSignal) return [notMutablePath(ctx, error.reason)];
      throw error;
    }
  }
  return buildNotMutable(typeKind, ctx);
}
