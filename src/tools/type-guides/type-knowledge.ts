/**
 * Curated BRP format knowledge for well-known Bevy / stdlib types.
 *
 * The static knowledge of how types should be serialized for BRP, which often
 * differs from their reflection-based representation.
 *
 * Substantially translated from upstream `bevy_brp_mcp` 0.22.3
 * `src/brp_tools/brp_type_guide/type_knowledge.rs` and `constants.rs`,
 * upstream commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`, MIT licensed
 * (see THIRD_PARTY_NOTICES.md).
 */
import type { Json, VariantSignature } from './model.js';
import { TypeGuideError } from './model.js';

/**
 * Format knowledge key for matching types (upstream `KnowledgeKey`).
 *
 * - `exact`: exact fully-qualified type name match.
 * - `struct-field`: struct field-specific match for appropriate field values.
 * - `enum-variant-signature`: indexed element within enum variants sharing a signature.
 */
export type KnowledgeKey =
  | { readonly kind: 'exact'; readonly typeName: string }
  | { readonly kind: 'struct-field'; readonly structType: string; readonly fieldName: string }
  | {
      readonly kind: 'enum-variant-signature';
      readonly enumType: string;
      readonly signature: VariantSignature;
      readonly index: number;
    };

/**
 * Hardcoded BRP format knowledge for a type (upstream `TypeKnowledge`):
 * - `teach-and-recurse`: override the example but still expose children.
 * - `treat-as-root-value`: treat as opaque (no mutation paths beneath).
 */
export type TypeKnowledgeEntry =
  | { readonly kind: 'teach-and-recurse'; readonly example: Json }
  | { readonly kind: 'treat-as-root-value'; readonly example: Json; readonly simplifiedType: string };

function treatAs(example: Json, simplifiedType: string): TypeKnowledgeEntry {
  return { kind: 'treat-as-root-value', example, simplifiedType };
}

function teach(example: Json): TypeKnowledgeEntry {
  return { kind: 'teach-and-recurse', example };
}

/** Canonical map key for a knowledge lookup. */
function knowledgeKeyString(key: KnowledgeKey): string {
  switch (key.kind) {
    case 'exact':
      return `exact|${key.typeName}`;
    case 'struct-field':
      return `field|${key.structType}|${key.fieldName}`;
    case 'enum-variant-signature': {
      const sig = key.signature;
      const sigKey =
        sig.variant === 'Unit'
          ? 'unit'
          : sig.variant === 'Tuple'
            ? `tuple(${sig.types.join(',')})`
            : `struct(${sig.fields.map((f) => `${f.name}:${f.typeName}`).join(',')})`;
      return `sig|${key.enumType}|${sigKey}|${key.index}`;
    }
  }
}

// Example scalars (upstream `constants.rs` EXAMPLE_* scalars).
const EXAMPLE_I8 = 42;
const EXAMPLE_I16 = 1;
const EXAMPLE_I32 = 1;
const EXAMPLE_I64 = 1;
const EXAMPLE_I128 = '123456789012345678901234567890';
const EXAMPLE_U8 = 128;
const EXAMPLE_U16 = 5000;
const EXAMPLE_U32 = 1;
const EXAMPLE_U64 = 1;
const EXAMPLE_U128 = '987654321098765432109876543210';
const EXAMPLE_F32 = 1.0;
const EXAMPLE_F64 = 1.0;
const EXAMPLE_ISIZE = 1;
const EXAMPLE_USIZE = 2;
const EXAMPLE_STRING = 'Hello, World!';
const EXAMPLE_STATIC_STR = 'static string';
const EXAMPLE_CHAR = 'A';
const EXAMPLE_BOOL = true;
const EXAMPLE_ENTITY_BITS = 8_589_934_670;
const EXAMPLE_NAME = 'Entity Name';
const EXAMPLE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const EXAMPLE_VEC2 = [1.0, 2.0];
const EXAMPLE_VEC3 = [1.0, 2.0, 3.0];
const EXAMPLE_VEC4 = [1.0, 2.0, 3.0, 4.0];
const EXAMPLE_DVEC2 = [1.0, 2.0];
const EXAMPLE_DVEC3 = [1.0, 2.0, 3.0];
const EXAMPLE_DVEC4 = [1.0, 2.0, 3.0, 4.0];
const EXAMPLE_IVEC2 = [0, 0];
const EXAMPLE_IVEC3 = [0, 0, 0];
const EXAMPLE_IVEC4 = [0, 0, 0, 0];
const EXAMPLE_UVEC2 = [0, 0];
const EXAMPLE_UVEC3 = [0, 0, 0];
const EXAMPLE_UVEC4 = [0, 0, 0, 0];
const EXAMPLE_QUAT = [0.0, 0.0, 0.0, 1.0];
const EXAMPLE_MAT2 = [1.0, 0.0, 0.0, 1.0];
const EXAMPLE_MAT3 = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
const EXAMPLE_MAT4 = [
  1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];
const EXAMPLE_GLOBAL_TRANSFORM = [
  1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
];
const EXAMPLE_AFFINE2 = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
const EXAMPLE_AFFINE3A = [
  1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
];
const EXAMPLE_RECT_MIN = [0.0, 0.0];
const EXAMPLE_RECT_MAX = [100.0, 100.0];
const EXAMPLE_VIDEO_MODE_PHYSICAL_SIZE = [1920, 1080];
const EXAMPLE_ALPHA_MODE_2D_MASK = 0.5;
const EXAMPLE_CAMERA3D_DEPTH_TEXTURE_USAGES = 20;
const EXAMPLE_CAMERA3D_SCREEN_SPACE_SPECULAR_TRANSMISSION_STEPS = 1;
const EXAMPLE_WINDOW_RESOLUTION_PHYSICAL_WIDTH = 800;
const EXAMPLE_WINDOW_RESOLUTION_PHYSICAL_HEIGHT = 600;
const EXAMPLE_GLYPH_INDEX = 5;
const EXAMPLE_VIDEO_MODE_BIT_DEPTH = 32;
const EXAMPLE_VIDEO_MODE_REFRESH_RATE_MILLIHERTZ = 60_000;
const EXAMPLE_BLOOM_MAX_MIP_DIMENSION = 512;
const EXAMPLE_FIXED_TIMESTEP_NANOS = 15_625_000;
const EXAMPLE_VIRTUAL_MAX_DELTA_NANOS = 250_000_000;
const DEFAULT_WRAP_PERIOD_SECS = 3_600;

/** `{secs, nanos}` duration object (upstream `constants.rs` `duration_value`; keys sorted). */
function durationValue(seconds: number, nanoseconds: number): Json {
  return { nanos: nanoseconds, secs: seconds };
}

/** Bevy math `Rect` object (upstream `constants.rs` `rect_value`; keys sorted). */
function rectValue(): Json {
  return { max: EXAMPLE_RECT_MAX, min: EXAMPLE_RECT_MIN };
}

/** `{"Window": "Primary"}` render target (upstream `primary_window_target_value`). */
function primaryWindowTargetValue(): Json {
  return { Window: 'Primary' };
}

/**
 * Static map of hardcoded BRP format knowledge (upstream `BRP_TYPE_KNOWLEDGE`).
 *
 * This captures the serialization rules that can't be derived from the
 * registry: Bevy math types serialize as flat arrays, `Entity` as its bit
 * width, `Name` as a plain string, `Duration` as a two-field struct, etc.
 */
const BRP_TYPE_KNOWLEDGE: ReadonlyMap<string, TypeKnowledgeEntry> = buildKnowledge();

function buildKnowledge(): Map<string, TypeKnowledgeEntry> {
  const map = new Map<string, TypeKnowledgeEntry>();
  const insert = (key: KnowledgeKey, entry: TypeKnowledgeEntry): void => {
    map.set(knowledgeKeyString(key), entry);
  };
  const exact = (typeName: string): KnowledgeKey => ({ kind: 'exact', typeName });
  const field = (structType: string, fieldName: string): KnowledgeKey => ({
    kind: 'struct-field',
    structType,
    fieldName,
  });

  // ===== Numeric types =====
  insert(exact('i8'), treatAs(EXAMPLE_I8, 'i8'));
  insert(exact('i16'), treatAs(EXAMPLE_I16, 'i16'));
  insert(exact('i32'), treatAs(EXAMPLE_I32, 'i32'));
  insert(exact('i64'), treatAs(EXAMPLE_I64, 'i64'));
  insert(exact('i128'), treatAs(EXAMPLE_I128, 'i128'));
  insert(exact('u8'), treatAs(EXAMPLE_U8, 'u8'));
  insert(exact('u16'), treatAs(EXAMPLE_U16, 'u16'));
  insert(exact('u32'), treatAs(EXAMPLE_U32, 'u32'));
  insert(exact('u64'), treatAs(EXAMPLE_U64, 'u64'));
  insert(exact('u128'), treatAs(EXAMPLE_U128, 'u128'));
  insert(exact('f32'), treatAs(EXAMPLE_F32, 'f32'));
  insert(exact('f64'), treatAs(EXAMPLE_F64, 'f64'));

  // ===== Size types =====
  insert(exact('isize'), treatAs(EXAMPLE_ISIZE, 'isize'));
  insert(exact('usize'), treatAs(EXAMPLE_USIZE, 'usize'));

  // ===== Text types =====
  insert(exact('alloc::string::String'), treatAs(EXAMPLE_STRING, 'String'));
  insert(exact('std::string::String'), treatAs(EXAMPLE_STRING, 'String'));
  insert(exact('String'), treatAs(EXAMPLE_STRING, 'String'));
  insert(exact('&str'), treatAs(EXAMPLE_STATIC_STR, 'str'));
  insert(exact('str'), treatAs(EXAMPLE_STATIC_STR, 'str'));
  insert(exact('char'), treatAs(EXAMPLE_CHAR, 'char'));

  // ===== Boolean =====
  insert(exact('bool'), treatAs(EXAMPLE_BOOL, 'bool'));

  // ===== Time types =====
  // Duration - core time type with secs (u64) and nanos (u32) fields.
  // Serializes as struct with both fields required.
  insert(exact('core::time::Duration'), treatAs(durationValue(0, 0), 'core::time::Duration'));

  // ===== Unit tuple =====
  // Unit tuple () serializes as empty array [] in BRP mutations; required for
  // `bevy_time::time::Time<()>`.
  insert(exact('()'), treatAs([], '()'));

  // ===== UUID =====
  // Standard UUID v4 format string.
  insert(exact('uuid::Uuid'), treatAs(EXAMPLE_UUID, 'Uuid'));

  // ===== Bevy math types (these serialize as arrays, not objects!) =====
  insert(exact('bevy_math::vec2::Vec2'), teach(EXAMPLE_VEC2));
  insert(exact('glam::Vec2'), teach(EXAMPLE_VEC2));

  insert(exact('bevy_math::vec3::Vec3'), teach(EXAMPLE_VEC3));
  insert(exact('bevy_math::vec3a::Vec3A'), teach(EXAMPLE_VEC3));
  insert(exact('glam::Vec3'), teach(EXAMPLE_VEC3));
  insert(exact('glam::Vec3A'), teach(EXAMPLE_VEC3));

  insert(exact('bevy_math::vec4::Vec4'), teach(EXAMPLE_VEC4));
  insert(exact('glam::Vec4'), teach(EXAMPLE_VEC4));

  // Double-precision vectors (f64)
  insert(exact('glam::DVec2'), teach(EXAMPLE_DVEC2));
  insert(exact('glam::DVec3'), teach(EXAMPLE_DVEC3));
  insert(exact('glam::DVec4'), teach(EXAMPLE_DVEC4));

  // Integer vectors
  insert(exact('glam::IVec2'), teach(EXAMPLE_IVEC2));
  insert(exact('glam::IVec3'), teach(EXAMPLE_IVEC3));
  insert(exact('glam::IVec4'), teach(EXAMPLE_IVEC4));

  // Unsigned vectors
  insert(exact('glam::UVec2'), teach(EXAMPLE_UVEC2));
  insert(exact('glam::UVec3'), teach(EXAMPLE_UVEC3));
  insert(exact('glam::UVec4'), teach(EXAMPLE_UVEC4));

  // Quaternion
  insert(exact('bevy_math::quat::Quat'), teach(EXAMPLE_QUAT));
  insert(exact('glam::Quat'), teach(EXAMPLE_QUAT));

  // Matrices
  insert(exact('bevy_math::mat2::Mat2'), teach(EXAMPLE_MAT2));
  insert(exact('glam::Mat2'), teach(EXAMPLE_MAT2));
  insert(exact('bevy_math::mat3::Mat3'), teach(EXAMPLE_MAT3));
  insert(exact('glam::Mat3'), teach(EXAMPLE_MAT3));
  // Mat3A - Used in GlobalTransform.0.matrix3, expects flat array not nested object
  // The error was: "invalid type: map, expected a sequence of 9 f32values"
  insert(exact('glam::Mat3A'), teach(EXAMPLE_MAT3));
  // Mat4 - BRP expects flat array of 16 values, not nested 2D array
  insert(exact('bevy_math::mat4::Mat4'), teach(EXAMPLE_MAT4));
  insert(exact('glam::Mat4'), teach(EXAMPLE_MAT4));

  // ===== Bevy math Rect =====
  // Has nested paths via Vec2 fields.
  insert(exact('bevy_math::rects::rect::Rect'), teach(rectValue()));

  // ===== Bevy ECS types =====
  // Entity - serializes as u64 (entity.to_bits()), not as struct.
  // WARNING: This is just an example! For actual BRP operations, use VALID entity IDs
  // obtained from spawn operations or queries. Using invalid entity IDs will cause errors.
  insert(
    exact('bevy_ecs::entity::Entity'),
    treatAs(EXAMPLE_ENTITY_BITS, 'bevy_ecs::entity::Entity'),
  );

  // Name serializes as a plain string, not as a struct with hash/name fields.
  insert(exact('bevy_ecs::name::Name'), treatAs(EXAMPLE_NAME, 'String'));

  // ===== Camera field-specific values =====
  // Provide safe RenderTarget default example to prevent crashes from invalid TextureView
  // handles. TextureView variant requires handle to exist in ManualTextureViews resource;
  // Window::Primary is always valid and references the default primary window.
  // Use TeachAndRecurse to provide safe default while still exposing nested mutation paths.
  insert(field('bevy_camera::camera::Camera', 'target'), teach(primaryWindowTargetValue()));

  // ===== Camera3d field-specific values =====
  // Camera3dDepthTextureUsage - wrapper around u32 texture usage flags.
  // Valid flags: COPY_SRC=1, COPY_DST=2, TEXTURE_BINDING=4, STORAGE_BINDING=8,
  // RENDER_ATTACHMENT=16. STORAGE_BINDING (8) causes crashes with multisampled textures!
  // Safe combinations: 16 (RENDER_ATTACHMENT only), 20 (RENDER_ATTACHMENT | TEXTURE_BINDING).
  // RENDER_ATTACHMENT | TEXTURE_BINDING - safe combination, treat as opaque u32.
  insert(
    field('bevy_camera::components::Camera3d', 'depth_texture_usages'),
    treatAs(EXAMPLE_CAMERA3D_DEPTH_TEXTURE_USAGES, 'u32'),
  );

  // Screen space specular transmission steps - reasonable value to prevent memory issues.
  // Default is 1, typical range is 0-4 per transmission.rs example.
  insert(
    field('bevy_camera::components::Camera3d', 'screen_space_specular_transmission_steps'),
    treatAs(EXAMPLE_CAMERA3D_SCREEN_SPACE_SPECULAR_TRANSMISSION_STEPS, 'usize'),
  );

  // ===== Transform types =====
  // GlobalTransform - wraps glam::Affine3A but serializes as flat array of 12 f32 values.
  // Format: [matrix_row1(3), matrix_row2(3), matrix_row3(3), translation(3)].
  // Registry shows nested object but BRP actually expects flat array.
  // Affine matrices don't have simple component access.
  insert(exact('bevy_transform::components::global_transform::GlobalTransform'), teach(EXAMPLE_GLOBAL_TRANSFORM));

  // Affine2 - Used in UiGlobalTransform.0, serializes as flat array of 6 f32 values.
  // Format: [matrix_row1(2), matrix_row2(2), translation(2)].
  insert(exact('glam::Affine2'), teach(EXAMPLE_AFFINE2));

  // Affine3A - Used as GlobalTransform.0, serializes as flat array of 12 f32 values.
  // Format: [matrix_row1(3), matrix_row2(3), matrix_row3(3), translation(3)].
  // Has matrix3 and translation fields but doesn't serialize with field names.
  insert(exact('glam::Affine3A'), teach(EXAMPLE_AFFINE3A));

  // ===== WindowResolution field-specific values =====
  // Provide reasonable window dimension values to prevent GPU texture size errors.
  insert(
    field('bevy_window::window::WindowResolution', 'physical_width'),
    treatAs(EXAMPLE_WINDOW_RESOLUTION_PHYSICAL_WIDTH, 'u32'),
  );
  insert(
    field('bevy_window::window::WindowResolution', 'physical_height'),
    treatAs(EXAMPLE_WINDOW_RESOLUTION_PHYSICAL_HEIGHT, 'u32'),
  );

  // ===== GlyphAtlasLocation field-specific values =====
  // Provide safe glyph index to prevent crashes from out-of-bounds atlas access.
  insert(
    field('bevy_text::glyph::GlyphAtlasLocation', 'glyph_index'),
    treatAs(EXAMPLE_GLYPH_INDEX, 'usize'),
  );

  // ===== VideoMode field-specific values =====
  // Provide realistic video mode values to prevent window system crashes.
  insert(
    field('bevy_window::monitor::VideoMode', 'bit_depth'),
    treatAs(EXAMPLE_VIDEO_MODE_BIT_DEPTH, 'u16'),
  );
  insert(
    field('bevy_window::monitor::VideoMode', 'physical_size'),
    treatAs(EXAMPLE_VIDEO_MODE_PHYSICAL_SIZE, 'UVec2'),
  );
  insert(
    field('bevy_window::monitor::VideoMode', 'refresh_rate_millihertz'),
    treatAs(EXAMPLE_VIDEO_MODE_REFRESH_RATE_MILLIHERTZ, 'u32'),
  );

  // ===== Bloom field-specific values =====
  // Provide safe max_mip_dimension to prevent GPU texture allocation crashes.
  // Default is 512; a u32 generic value of 1_000_000 causes rendering pipeline corruption.
  insert(
    field('bevy_post_process::bloom::settings::Bloom', 'max_mip_dimension'),
    treatAs(EXAMPLE_BLOOM_MAX_MIP_DIMENSION, 'u32'),
  );

  // ===== NonZero types =====
  // These types guarantee the value is never zero.
  insert(exact('core::num::NonZeroU8'), treatAs(1, 'NonZeroU8'));
  insert(exact('core::num::NonZeroU16'), treatAs(1, 'NonZeroU16'));
  insert(exact('core::num::NonZeroU32'), treatAs(1, 'NonZeroU32'));
  insert(exact('core::num::NonZeroU64'), treatAs(1, 'NonZeroU64'));
  insert(exact('core::num::NonZeroU128'), treatAs(1, 'NonZeroU128'));
  insert(exact('core::num::NonZeroUsize'), treatAs(1, 'NonZeroUsize'));
  insert(exact('core::num::NonZeroI8'), treatAs(1, 'NonZeroI8'));
  insert(exact('core::num::NonZeroI16'), treatAs(1, 'NonZeroI16'));
  insert(exact('core::num::NonZeroI32'), treatAs(1, 'NonZeroI32'));
  insert(exact('core::num::NonZeroI64'), treatAs(1, 'NonZeroI64'));
  insert(exact('core::num::NonZeroI128'), treatAs(1, 'NonZeroI128'));
  insert(exact('core::num::NonZeroIsize'), treatAs(1, 'NonZeroIsize'));

  // ===== Time<Fixed> field-specific values =====
  // wrap_period must be non-zero to prevent divide-by-zero in time wrapping calculations.
  // Default is 3600 seconds (1 hour) - setting to zero causes panic in run_fixed_main_schedule.
  insert(
    field('bevy_time::time::Time<bevy_time::fixed::Fixed>', 'wrap_period'),
    treatAs(durationValue(DEFAULT_WRAP_PERIOD_SECS, 0), 'core::time::Duration'),
  );

  // timestep must be non-zero for fixed timestep to function.
  // Default is 1/64 second (15625000 nanos) - setting to zero causes divide-by-zero panic.
  insert(
    field('bevy_time::fixed::Fixed', 'timestep'),
    treatAs(durationValue(0, EXAMPLE_FIXED_TIMESTEP_NANOS), 'core::time::Duration'),
  );

  // ===== Time<Virtual> field-specific values =====
  // wrap_period must be non-zero to prevent divide-by-zero in time wrapping calculations.
  // Default is 3600 seconds (1 hour) - setting to zero causes app crash.
  insert(
    field('bevy_time::time::Time<bevy_time::virt::Virtual>', 'wrap_period'),
    treatAs(durationValue(DEFAULT_WRAP_PERIOD_SECS, 0), 'core::time::Duration'),
  );

  // max_delta must be non-zero to allow virtual time to advance.
  // Default is 250ms (250000000 nanos) - setting to zero prevents time updates.
  insert(
    field('bevy_time::virt::Virtual', 'max_delta'),
    treatAs(durationValue(0, EXAMPLE_VIRTUAL_MAX_DELTA_NANOS), 'core::time::Duration'),
  );

  // ===== Time<Real> field-specific values =====
  // wrap_period must be non-zero to prevent divide-by-zero in time wrapping calculations.
  // Default is 3600 seconds (1 hour) - setting to zero causes app crash.
  insert(
    field('bevy_time::time::Time<bevy_time::real::Real>', 'wrap_period'),
    treatAs(durationValue(DEFAULT_WRAP_PERIOD_SECS, 0), 'core::time::Duration'),
  );

  // ===== Time<()> field-specific values =====
  // wrap_period must be non-zero to prevent divide-by-zero in time wrapping calculations.
  // Default is 3600 seconds (1 hour) - setting to zero causes app crash.
  insert(
    field('bevy_time::time::Time<()>', 'wrap_period'),
    treatAs(durationValue(DEFAULT_WRAP_PERIOD_SECS, 0), 'core::time::Duration'),
  );

  // ===== AlphaMode2d enum variant signatures =====
  // Mask(f32) variant requires alpha threshold in 0.0-1.0 range.
  insert(
    {
      kind: 'enum-variant-signature',
      enumType: 'bevy_sprite_render::mesh2d::material::AlphaMode2d',
      signature: { variant: 'Tuple', types: ['f32'] },
      index: 0,
    },
    treatAs(EXAMPLE_ALPHA_MODE_2D_MASK, 'f32'),
  );

  return map;
}

/** Look up a curated knowledge entry (upstream `BRP_TYPE_KNOWLEDGE.get`). */
export function getKnowledge(key: KnowledgeKey): TypeKnowledgeEntry | undefined {
  return BRP_TYPE_KNOWLEDGE.get(knowledgeKeyString(key));
}

/**
 * Get the simplified display name for a type if it has `TreatAsRootValue`
 * knowledge (upstream `TypeKnowledge::get_simplified_name`), e.g.
 * `alloc::string::String` → `"String"`.
 */
export function getSimplifiedName(typeName: string): string | undefined {
  const entry = getKnowledge({ kind: 'exact', typeName });
  return entry?.kind === 'treat-as-root-value' ? entry.simplifiedType : undefined;
}

/**
 * Get the example value for `bevy_ecs::entity::Entity` from type knowledge
 * (upstream `TypeKnowledge::get_entity_example_value`). Used for agent
 * guidance messages that reference Entity IDs.
 */
export function getEntityExampleValue(): number {
  const entry = getKnowledge({ kind: 'exact', typeName: 'bevy_ecs::entity::Entity' });
  const example = entry !== undefined && entry.kind !== 'teach-and-recurse'
    ? entry.example
    : undefined;
  if (typeof example !== 'number') {
    throw new TypeGuideError(
      'Entity type knowledge missing or invalid in BRP_TYPE_KNOWLEDGE',
    );
  }
  return example;
}
