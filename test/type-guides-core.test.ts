import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Json, Registry } from '../src/tools/type-guides/model.js';
import {
  AGENT_GUIDANCE,
  ERROR_GUIDANCE,
  MAX_TYPE_RECURSION_DEPTH,
  NOT_APPLICABLE,
  aggregateMutability,
  exampleToValue,
  notFoundInRegistry,
  parseTypeKind,
  processingFailed,
} from '../src/tools/type-guides/model.js';
import {
  displayName,
  extractFieldType,
  extractSchemaInfo,
  extractSimplifiedVariantName,
  shortEnumTypeName,
  shortName,
} from '../src/tools/type-guides/schema-info.js';
import {
  getEntityExampleValue,
  getSimplifiedName,
} from '../src/tools/type-guides/type-knowledge.js';
import {
  buildValueExample,
  type ValueContext,
} from '../src/tools/type-guides/value-builder.js';
import { buildMutationPaths } from '../src/tools/type-guides/mutation-paths.js';

// ===== Registry fixtures (captured live from the running Bevy fixture app) =====

const REGISTRY_DIR = fileURLToPath(
  new URL('../../test/contracts/type-guides/registry/', import.meta.url),
);

const CAPTURED: Record<string, Json> = {};
for (const file of readdirSync(REGISTRY_DIR)) {
  if (!file.endsWith('.json')) continue;
  const schema = JSON.parse(readFileSync(`${REGISTRY_DIR}${file}`, 'utf8')) as Json;
  const typePath = (schema as Record<string, string>).typePath;
  assert.equal(typeof typePath, 'string', `${file} must carry typePath`);
  CAPTURED[typePath] = schema;
}

function makeRegistry(extra: Record<string, Json> = {}): Registry {
  return new Map([...Object.entries(CAPTURED), ...Object.entries(extra)]);
}

function exampleOf(registry: Registry, typeName: string, ctx: Partial<ValueContext> = {}): Json {
  return exampleToValue(buildValueExample(registry, { typeName, depth: 0, ...ctx }).example);
}

// ===== Primitive fields =====

test('primitive struct field uses the curated primitive example', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, { typeName: 'bevy_mcp_fixture::FixtureValue', depth: 0 });
  assert.equal(result.mutability, 'Mutable');
  assert.deepEqual(exampleToValue(result.example), { value: 1 });
});

test('Value-kind leaf without knowledge has no example', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, { typeName: 'core::any::TypeId', depth: 0 });
  assert.equal(result.mutability, 'NotMutable');
  assert.equal(result.example, NOT_APPLICABLE);
});

// ===== Structs and Transform-related types =====

test('Transform assembles from Vec3/Quat knowledge examples', () => {
  const registry = makeRegistry();
  assert.deepEqual(exampleOf(registry, 'bevy_transform::components::transform::Transform'), {
    translation: [1, 2, 3],
    rotation: [0, 0, 0, 1],
    scale: [1, 2, 3],
  });
});

test('TeachAndRecurse types keep the curated flat-array example', () => {
  const registry = makeRegistry();
  assert.deepEqual(exampleOf(registry, 'glam::Vec3'), [1, 2, 3]);
  assert.deepEqual(exampleOf(registry, 'glam::Quat'), [0, 0, 0, 1]);
});

test('empty marker structs assemble to an empty object', () => {
  const registry = makeRegistry({
    'test::Marker': { shortPath: 'Marker', typePath: 'test::Marker', kind: 'Struct', type: 'object' },
  });
  const result = buildValueExample(registry, { typeName: 'test::Marker', depth: 0 });
  assert.equal(result.mutability, 'Mutable');
  assert.deepEqual(exampleToValue(result.example), {});
});

test('partially mutable structs assemble examples from mutable children only', () => {
  const registry = makeRegistry({
    'test::Mixed': {
      typePath: 'test::Mixed',
      kind: 'Struct',
      properties: {
        ok: { type: { $ref: '#/$defs/i32' } },
        bad: { type: { $ref: '#/$defs/test::Opaque' } },
      },
    },
    'test::Opaque': { typePath: 'test::Opaque', kind: 'Value' },
  });
  const result = buildValueExample(registry, { typeName: 'test::Mixed', depth: 0 });
  assert.equal(result.mutability, 'PartiallyMutable');
  assert.deepEqual(exampleToValue(result.example), { ok: 1 });
});

test('struct-field knowledge overrides generic type knowledge (Camera3d)', () => {
  const registry = makeRegistry({
    'bevy_camera::components::Camera3d': {
      typePath: 'bevy_camera::components::Camera3d',
      kind: 'Struct',
      properties: { depth_texture_usages: { type: { $ref: '#/$defs/u32' } } },
    },
  });
  // The field-specific entry yields 20 where the generic u32 entry would yield 1.
  assert.deepEqual(exampleOf(registry, 'bevy_camera::components::Camera3d'), {
    depth_texture_usages: 20,
  });
});

// ===== Tuple / tuple-struct =====

test('knowledge on a tuple struct short-circuits recursion (Name)', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, { typeName: 'bevy_ecs::name::Name', depth: 0 });
  assert.equal(result.mutability, 'Mutable');
  assert.equal(exampleToValue(result.example), 'Entity Name');
});

test('single-element tuple structs are unwrapped (ChildOf → Entity bits)', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, { typeName: 'bevy_ecs::hierarchy::ChildOf', depth: 0 });
  assert.equal(result.mutability, 'Mutable');
  assert.equal(exampleToValue(result.example), 8_589_934_670);
});

test('multi-element tuples assemble as arrays', () => {
  const registry = makeRegistry({
    'test::Pair': {
      typePath: 'test::Pair',
      kind: 'TupleStruct',
      prefixItems: [
        { type: { $ref: '#/$defs/i32' } },
        { type: { $ref: '#/$defs/alloc::string::String' } },
      ],
    },
  });
  assert.deepEqual(exampleOf(registry, 'test::Pair'), [1, 'Hello, World!']);
});

test('tuple structs wrapping a Handle element are immutable', () => {
  const registry = makeRegistry({
    'test::Avatar': {
      typePath: 'test::Avatar',
      kind: 'TupleStruct',
      prefixItems: [
        { type: { $ref: '#/$defs/bevy_asset::handle::Handle<bevy_asset::image::Image>' } },
      ],
    },
    // Synthetic mutable schema for the Handle element; the immutability comes
    // from the assemble-time Handle-wrapper check, not from the child.
    'bevy_asset::handle::Handle<bevy_asset::image::Image>': {
      typePath: 'bevy_asset::handle::Handle<bevy_asset::image::Image>',
      kind: 'Struct',
      properties: { id: { type: { $ref: '#/$defs/u32' } } },
    },
  });
  const result = buildValueExample(registry, { typeName: 'test::Avatar', depth: 0 });
  assert.equal(result.mutability, 'NotMutable');
  assert.equal(result.example, NOT_APPLICABLE);
});

// ===== Enum variants =====

test('enum preferred example selects the non-unit variant (FixtureMode)', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, { typeName: 'bevy_mcp_fixture::FixtureMode', depth: 0 });
  assert.equal(result.mutability, 'Mutable');
  assert.deepEqual(exampleToValue(result.example), { Moving: { speed: 1 } });
});

test('Option<String> transforms to the BRP wrap-unwrap representation', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, {
    typeName: 'core::option::Option<alloc::string::String>',
    depth: 0,
  });
  assert.equal(result.mutability, 'Mutable');
  assert.equal(exampleToValue(result.example), 'Hello, World!');
});

test('enum variant tuple element knowledge applies (AlphaMode2d::Mask)', () => {
  const registry = makeRegistry({
    'bevy_sprite_render::mesh2d::material::AlphaMode2d': {
      typePath: 'bevy_sprite_render::mesh2d::material::AlphaMode2d',
      kind: 'Enum',
      oneOf: [
        { typePath: 'bevy_sprite_render::mesh2d::material::AlphaMode2d::Opaque', shortPath: 'Opaque' },
        {
          type: 'array',
          kind: 'Tuple',
          typePath: 'bevy_sprite_render::mesh2d::material::AlphaMode2d::Mask',
          shortPath: 'Mask',
          prefixItems: [{ type: { $ref: '#/$defs/f32' } }],
        },
      ],
    },
  });
  const result = buildValueExample(registry, {
    typeName: 'bevy_sprite_render::mesh2d::material::AlphaMode2d',
    depth: 0,
  });
  assert.equal(result.mutability, 'Mutable');
  // 0.5 from the enum-signature knowledge entry, not the generic f32 example 1.0.
  assert.deepEqual(exampleToValue(result.example), { Mask: 0.5 });
});

// ===== Lists / arrays / maps / sets =====

test('arrays replicate the element example per inferred size', () => {
  const registry = makeRegistry();
  assert.deepEqual(exampleOf(registry, '[glam::Vec3; 2]'), [
    [1, 2, 3],
    [1, 2, 3],
  ]);
});

test('pathological array sizes fall back to the default example length', () => {
  const registry = makeRegistry({
    '[u8; 100000]': {
      typePath: '[u8; 100000]',
      kind: 'Array',
      type: 'array',
      items: { type: { $ref: '#/$defs/u8' } },
    },
  });
  // Both array example paths must cap the materialized length, not allocate
  // 100k elements for the declared size.
  assert.deepEqual(exampleOf(registry, '[u8; 100000]'), [128, 128]);
  const rootPath = buildMutationPaths('[u8; 100000]', registry).find((p) => p.path === '');
  assert.deepEqual(rootPath?.example, [128, 128]);
});

test('lists assemble a single-element array', () => {
  const registry = makeRegistry();
  assert.deepEqual(exampleOf(registry, 'alloc::vec::Vec<bevy_ecs::entity::Entity>'), [8_589_934_670]);
});

test('maps assemble from key/value examples', () => {
  const registry = makeRegistry({
    'test::StringMap': {
      typePath: 'test::StringMap',
      kind: 'Map',
      keyType: { type: { $ref: '#/$defs/alloc::string::String' } },
      valueType: { type: { $ref: '#/$defs/i32' } },
    },
  });
  const result = buildValueExample(registry, { typeName: 'test::StringMap', depth: 0 });
  assert.equal(result.mutability, 'Mutable');
  assert.deepEqual(exampleToValue(result.example), { 'Hello, World!': 1 });
});

test('maps with non-knowledge key types are not mutable (HashMap<TypeId, String>)', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, {
    typeName:
      'bevy_platform::collections::HashMap<core::any::TypeId, alloc::string::String, bevy_platform::hash::FixedHasher>',
    depth: 0,
  });
  assert.equal(result.mutability, 'NotMutable');
  assert.equal(result.example, NOT_APPLICABLE);
});

test('sets replicate the element example twice', () => {
  const registry = makeRegistry({
    'test::U8Set': {
      typePath: 'test::U8Set',
      kind: 'Set',
      items: { type: { $ref: '#/$defs/u8' } },
    },
  });
  const result = buildValueExample(registry, { typeName: 'test::U8Set', depth: 0 });
  assert.equal(result.mutability, 'Mutable');
  assert.deepEqual(exampleToValue(result.example), [128, 128]);
});

test('sets of complex elements are not mutable (HashSet<GamepadButton>)', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, {
    typeName:
      'bevy_platform::collections::HashSet<bevy_input::gamepad::GamepadButton, bevy_platform::hash::FixedHasher>',
    depth: 0,
  });
  // The GamepadButton preferred example is an object, which BRP cannot hash.
  assert.equal(result.mutability, 'NotMutable');
  assert.equal(result.example, NOT_APPLICABLE);
});

test('complex map keys are rejected as not mutable', () => {
  const registry = makeRegistry({
    'test::VecKeyMap': {
      typePath: 'test::VecKeyMap',
      kind: 'Map',
      keyType: { type: { $ref: '#/$defs/glam::Vec3' } },
      valueType: { type: { $ref: '#/$defs/i32' } },
    },
  });
  const result = buildValueExample(registry, { typeName: 'test::VecKeyMap', depth: 0 });
  assert.equal(result.mutability, 'NotMutable');
  assert.equal(result.example, NOT_APPLICABLE);
});

// ===== Nested refs =====

test('GlobalTransform flattens Affine3A to 12 f32 values', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, {
    typeName: 'bevy_transform::components::global_transform::GlobalTransform',
    depth: 0,
  });
  assert.equal(result.mutability, 'Mutable');
  assert.deepEqual(exampleToValue(result.example), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
});

// ===== Entity =====

test('Entity example is the documented bit value', () => {
  const registry = makeRegistry();
  assert.equal(getEntityExampleValue(), 8_589_934_670);
  assert.equal(exampleOf(registry, 'bevy_ecs::entity::Entity'), 8_589_934_670);
});

// ===== Missing / unregistered types =====

test('unregistered types produce a valid not-found guide, not a crash', () => {
  const registry = makeRegistry();
  const result = buildValueExample(registry, { typeName: 'my_app::NotRegistered', depth: 0 });
  assert.equal(result.mutability, 'NotMutable');
  assert.equal(result.example, NOT_APPLICABLE);

  const guide = notFoundInRegistry('my_app::NotRegistered', 'Type not found in registry');
  assert.equal(guide.in_registry, false);
  assert.equal(guide.agent_guidance, AGENT_GUIDANCE);
  assert.equal(guide.error, 'Type not found in registry');
  assert.equal(guide.mutation_paths, undefined);
  assert.equal(guide.schema_info, undefined);
});

// ===== Processing failures return per-type errors =====

test('malformed struct field schema raises TypeGuideError', () => {
  const registry = makeRegistry({
    'test::BadField': {
      typePath: 'test::BadField',
      kind: 'Struct',
      properties: { broken: { type: {} } },
    },
  });
  assert.throws(
    () => buildValueExample(registry, { typeName: 'test::BadField', depth: 0 }),
    /Failed to extract type for field 'broken' in struct 'test::BadField'/,
  );
});

test('enum schema without oneOf raises TypeGuideError', () => {
  const registry = makeRegistry({
    'test::BadEnum': { typePath: 'test::BadEnum', kind: 'Enum' },
  });
  assert.throws(
    () => buildValueExample(registry, { typeName: 'test::BadEnum', depth: 0 }),
    /missing oneOf field in schema/,
  );
});

test('processing failure yields a per-type error guide instead of crashing', () => {
  const guide = processingFailed('test::BadField', 'Failed to extract type for field');
  assert.equal(guide.in_registry, true);
  assert.equal(guide.agent_guidance, ERROR_GUIDANCE);
  assert.equal(guide.error, 'Failed to extract type for field');
  assert.equal(guide.mutation_paths, undefined);
});

// ===== Recursion depth =====

test('self-referencing types stop at the recursion depth limit', () => {
  const registry = makeRegistry({
    'test::A': {
      typePath: 'test::A',
      kind: 'Struct',
      properties: { b: { type: { $ref: '#/$defs/test::B' } } },
    },
    'test::B': {
      typePath: 'test::B',
      kind: 'Struct',
      properties: { a: { type: { $ref: '#/$defs/test::A' } } },
    },
  });
  const result = buildValueExample(registry, { typeName: 'test::A', depth: 0 });
  assert.equal(result.mutability, 'NotMutable');
  assert.equal(result.example, NOT_APPLICABLE);
  // Sanity: the limit is what stops the recursion, not the cycle itself.
  assert.ok(MAX_TYPE_RECURSION_DEPTH >= 10);
});

// ===== Schema-info behavior =====

test('parseTypeKind falls back to Value for missing or unknown kinds', () => {
  assert.equal(parseTypeKind({ kind: 'Struct' }), 'Struct');
  assert.equal(parseTypeKind({}), 'Value');
  assert.equal(parseTypeKind({ kind: 'bogus' }), 'Value');
  assert.equal(parseTypeKind(null), 'Value');
});

test('extractSchemaInfo captures registry metadata', () => {
  const info = extractSchemaInfo(CAPTURED['bevy_mcp_fixture::FixtureValue']!);
  assert.equal(info.type_kind, 'Struct');
  assert.deepEqual(info.required, ['value']);
  assert.equal(info.module_path, 'bevy_mcp_fixture');
  assert.equal(info.crate_name, 'bevy_mcp_fixture');
  assert.deepEqual(info.reflect_traits, ['Component']);
  assert.deepEqual(info.component_info, {
    mutable: true,
    storageType: 'Table',
    isSendAndSync: true,
  });
});

test('shortName shortens paths, generics and arrays', () => {
  assert.equal(shortName('bevy_ecs::name::Name'), 'Name');
  assert.equal(shortName('[glam::Vec3; 2]'), '[Vec3; 2]');
  assert.equal(
    shortName(
      'bevy_platform::collections::HashMap<core::any::TypeId, alloc::string::String, bevy_platform::hash::FixedHasher>',
    ),
    'HashMap',
  );
});

test('displayName uses curated simplified names when available', () => {
  assert.equal(displayName('alloc::string::String'), 'String');
  assert.equal(displayName('glam::Vec3'), 'glam::Vec3');
  assert.equal(getSimplifiedName('bevy_ecs::name::Name'), 'String');
  assert.equal(getSimplifiedName('glam::Vec3'), undefined);
});

test('shortEnumTypeName preserves generic parameters', () => {
  assert.equal(shortEnumTypeName('core::option::Option<alloc::string::String>'), 'Option<String>');
  assert.equal(shortEnumTypeName('bevy_mcp_fixture::FixtureMode'), 'FixtureMode');
});

test('extractSimplifiedVariantName simplifies module paths', () => {
  assert.equal(
    extractSimplifiedVariantName('core::option::Option<alloc::string::String>::Some'),
    'Option<String>::Some',
  );
  assert.equal(
    extractSimplifiedVariantName('bevy_mcp_fixture::FixtureMode::Moving'),
    'FixtureMode::Moving',
  );
});

test('extractFieldType reads $ref type names', () => {
  assert.equal(extractFieldType({ type: { $ref: '#/$defs/i32' } }), 'i32');
  assert.equal(extractFieldType({ type: {} }), undefined);
  assert.equal(extractFieldType({}), undefined);
});

// ===== Mutability aggregation =====

test('aggregateMutability follows upstream rules', () => {
  assert.equal(aggregateMutability([]), 'Mutable');
  assert.equal(aggregateMutability(['Mutable']), 'Mutable');
  assert.equal(aggregateMutability(['NotMutable']), 'NotMutable');
  assert.equal(aggregateMutability(['Mutable', 'NotMutable']), 'PartiallyMutable');
  assert.equal(aggregateMutability(['Mutable', 'PartiallyMutable']), 'PartiallyMutable');
  assert.equal(aggregateMutability(['NotMutable', 'PartiallyMutable']), 'PartiallyMutable');
});
