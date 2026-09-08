/**
 * Type-name and registry-schema interpretation for the type guides.
 *
 * Ported from the pinned upstream `bevy_brp_mcp` 0.22.3 modules
 * `brp_type_name.rs`, `support.rs` (schema field access), `guide.rs`
 * (`extract_schema_info`), `enum_builder/variant_kind.rs` and
 * `mutation_path_builder/type_parser.rs`, upstream
 * commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`, MIT licensed
 * (see THIRD_PARTY_NOTICES.md).
 */
import type {
  Json,
  SchemaInfo,
  TypeKind,
  VariantName,
  VariantSignature,
} from './model.js';
import { parseTypeKind, TypeGuideError } from './model.js';

/** Prefix of `$ref` values pointing at registry type definitions. */
const SCHEMA_REF_PREFIX = '#/$defs/';

/** Prefix marking Bevy asset `Handle<T>` wrapper types. */
const BEVY_ASSET_HANDLE_PREFIX = 'bevy_asset::handle::Handle<';

/** Read a field from a schema object. */
export function getField(schema: Json, field: string): Json | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  return schema[field];
}

/** Read a field as a string. */
export function getFieldStr(schema: Json, field: string): string | undefined {
  const value = getField(schema, field);
  return typeof value === 'string' ? value : undefined;
}

/** Read a field as an array. */
export function getFieldArray(schema: Json, field: string): Json[] | undefined {
  const value = getField(schema, field);
  return Array.isArray(value) ? value : undefined;
}

/**
 * Extract a type name from a field definition containing `type.$ref`
 * (e.g. `{"type": {"$ref": "#/$defs/i32"}}` → `"i32"`).
 */
export function extractFieldType(fieldSchema: Json): string | undefined {
  const ref = getFieldStr(getField(fieldSchema, 'type') ?? null, '$ref');
  if (ref === undefined) return undefined;
  return ref.startsWith(SCHEMA_REF_PREFIX) ? ref.slice(SCHEMA_REF_PREFIX.length) : undefined;
}

/** Get the `properties` field as an object. */
export function getProperties(schema: Json): Record<string, Json> | undefined {
  const value = getField(schema, 'properties');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, Json>;
}

/**
 * Extract schema information for the guide's `schema_info` field
 * (upstream `guide.rs` `extract_schema_info`). Note: unlike `parseTypeKind`,
 * an invalid `kind` leaves `type_kind` absent rather than falling back.
 */
export function extractSchemaInfo(registrySchema: Json): SchemaInfo {
  const info: SchemaInfo = {};

  const kind = getFieldStr(registrySchema, 'kind');
  if (kind !== undefined && (TYPE_KIND_VALUES as readonly string[]).includes(kind)) {
    info.type_kind = kind as TypeKind;
  }

  const properties = getField(registrySchema, 'properties');
  if (properties !== undefined) info.properties = properties;

  const required = getFieldArray(registrySchema, 'required');
  if (required !== undefined) {
    info.required = required.filter((v): v is string => typeof v === 'string');
  }

  const modulePath = getFieldStr(registrySchema, 'modulePath');
  if (modulePath !== undefined) info.module_path = modulePath;

  const crateName = getFieldStr(registrySchema, 'crateName');
  if (crateName !== undefined) info.crate_name = crateName;

  const reflectTypes = getFieldArray(registrySchema, 'reflectTypes');
  if (reflectTypes !== undefined) {
    info.reflect_traits = reflectTypes.filter((v): v is string => typeof v === 'string');
  }

  const componentInfo = getField(registrySchema, 'componentInfo');
  if (componentInfo !== undefined) info.component_info = componentInfo;

  return info;
}

const TYPE_KIND_VALUES = [
  'Array',
  'Enum',
  'List',
  'Map',
  'Struct',
  'Set',
  'Tuple',
  'TupleStruct',
  'Value',
] as const;

/** True for `bevy_asset::handle::Handle<...>` wrapper types. */
export function isHandle(typeName: string): boolean {
  return typeName.startsWith(BEVY_ASSET_HANDLE_PREFIX);
}

/**
 * Short name (last `::` segment). Generic types return the base short name
 * (`HashMap<String, i32>` → `"HashMap"`); arrays keep array syntax
 * (`[glam::Vec3; 2]` → `"[Vec3; 2]"`). (upstream `brp_type_name.rs`.)
 */
export function shortName(typeName: string): string {
  const anglePos = typeName.indexOf('<');
  if (anglePos !== -1) {
    const base = typeName.slice(0, anglePos);
    return lastSegment(base);
  }

  if (typeName.startsWith('[') && typeName.endsWith(']')) {
    const semicolonPos = typeName.lastIndexOf(';');
    const bracketPos = typeName.indexOf('[');
    if (semicolonPos !== -1 && bracketPos !== -1) {
      const innerType = typeName.slice(bracketPos + 1, semicolonPos);
      const sizePart = typeName.slice(semicolonPos);
      return `[${lastSegment(innerType)}${sizePart}`;
    }
  }

  return lastSegment(typeName);
}

function lastSegment(path: string): string {
  const pos = path.lastIndexOf('::');
  return pos === -1 ? path : path.slice(pos + 2);
}

/**
 * Display name for a type, using the curated simplified name from type
 * knowledge when available (e.g. `alloc::string::String` → `"String"`).
 */
export function displayName(typeName: string): string {
  return getSimplifiedName(typeName) ?? typeName;
}

/**
 * Shorten an enum type name while preserving generic parameters:
 * `core::option::Option<alloc::string::String>` → `"Option<String>"`.
 */
export function shortEnumTypeName(typeName: string): string {
  const anglePos = typeName.indexOf('<');
  if (anglePos === -1) return lastSegment(typeName);

  const base = typeName.slice(0, anglePos);
  const genericPart = typeName.slice(anglePos);
  const inner = genericPart.slice(1, -1); // strip < >
  const parts = inner.split(',').map((part) => {
    const trimmed = part.trim();
    return trimmed.includes('::') ? lastSegment(trimmed) : trimmed;
  });
  return `${lastSegment(base)}<${parts.join(', ')}>`;
}

// ===== Enum variant parsing (upstream `variant_kind.rs`) =====

/** A schema-variant's name plus its structural signature. */
export interface VariantKind {
  readonly variantName: VariantName;
  readonly signature: VariantSignature;
}

/**
 * Parse all `oneOf` variants of an enum schema into names + signatures.
 * Unit variants appear as plain strings or bare path objects; tuple/struct
 * variants carry `prefixItems`/`properties`.
 * (upstream `VariantKind::from_schema_variant`.)
 */
export function parseEnumVariants(schema: Json, enumType: string): VariantKind[] {
  const oneOf = getFieldArray(schema, 'oneOf');
  if (oneOf === undefined) {
    throw new TypeGuideError(`Enum type ${enumType} missing oneOf field in schema`);
  }
  return oneOf.map((v) => variantFromSchema(v, enumType));
}

function variantFromSchema(v: Json, enumType: string): VariantKind {
  if (typeof v === 'string') {
    // Unit variants show up as simple strings; qualify with the enum's short name.
    return {
      variantName: `${lastSegment(enumType)}::${v}`,
      signature: { variant: 'Unit' },
    };
  }

  const name = extractVariantQualifiedName(v, enumType);

  const tuple = extractTupleVariantSignature(v);
  if (tuple) return { variantName: name, signature: tuple };

  const struct = extractStructVariantSignature(v);
  if (struct) return { variantName: name, signature: struct };

  return { variantName: name, signature: { variant: 'Unit' } };
}

function extractVariantQualifiedName(v: Json, enumType: string): VariantName {
  const typePath = getFieldStr(v, 'typePath');
  if (typePath !== undefined) {
    return extractSimplifiedVariantName(typePath);
  }
  const shortPath = getFieldStr(v, 'shortPath');
  if (shortPath !== undefined) return shortPath;
  throw new TypeGuideError(
    `Enum type ${enumType} has malformed variant: missing typePath and shortPath fields`,
  );
}

function extractTupleVariantSignature(v: Json): VariantSignature | undefined {
  const prefixItems = getFieldArray(v, 'prefixItems');
  if (prefixItems === undefined) return undefined;
  return {
    variant: 'Tuple',
    types: prefixItems
      .map((item) => extractFieldType(item))
      .filter((t): t is string => t !== undefined),
  };
}

function extractStructVariantSignature(v: Json): VariantSignature | undefined {
  const properties = getProperties(v);
  if (properties === undefined) return undefined;
  const fields = Object.entries(properties)
    .map(([name, fieldSchema]) => {
      const typeName = extractFieldType(fieldSchema);
      return typeName === undefined ? undefined : { name, typeName };
    })
    .filter((f): f is { name: string; typeName: string } => f !== undefined);
  if (fields.length === 0) return undefined;
  return { variant: 'Struct', fields };
}

// ===== Type-path parsing (upstream `mutation_path_builder/type_parser.rs`) =====

/**
 * Extract a simplified variant name from a full type path:
 * `core::option::Option<alloc::string::String>::Some` → `"Option<String>::Some"`.
 * Falls back to `"UnknownType::<Variant>"` (or the bare input) when parsing fails.
 */
export function extractSimplifiedVariantName(typePath: string): string {
  const parsed = parseTypeWithVariant(typePath);
  if (parsed === undefined) {
    const pos = typePath.lastIndexOf('::');
    return pos === -1
      ? typePath
      : `UnknownType::${typePath.slice(pos + 2)}`;
  }
  const { simplifiedType, variant } = parsed;
  return variant === undefined ? simplifiedType : `${simplifiedType}::${variant}`;
}

interface ParsedTypePath {
  simplifiedType: string;
  variant?: string;
}

function parseTypeWithVariant(typePath: string): ParsedTypePath | undefined {
  // Special case: simple `Type::Variant` without generics splits at the last `::`.
  if (!typePath.includes('<')) {
    const separatorCount = countOccurrences(typePath, '::');
    if (separatorCount === 1) {
      const pos = typePath.indexOf('::');
      return {
        simplifiedType: simplifyType(typePath.slice(0, pos)),
        variant: typePath.slice(pos + 2),
      };
    }
    if (separatorCount > 1) {
      const lastPos = typePath.lastIndexOf('::');
      const variant = typePath.slice(lastPos + 2);
      if (/^[A-Z]/.test(variant)) {
        return {
          simplifiedType: simplifyType(typePath.slice(0, lastPos)),
          variant,
        };
      }
    }
    // Zero separators: a bare type name.
    if (separatorCount === 0) return { simplifiedType: typePath };
  }

  // Generics present: parse the type path, then an optional `::Variant`.
  const typePart = parseTypePath(typePath);
  if (typePart === undefined) return undefined;
  const rest = typePath.slice(typePart.length);
  let variant: string | undefined;
  if (rest.startsWith('::')) {
    const id = parseIdentifier(rest.slice(2));
    if (id === undefined) return undefined;
    variant = rest.slice(2, 2 + id);
    if (2 + id !== rest.length) return undefined;
  } else if (rest.length !== 0) {
    return undefined;
  }
  return { simplifiedType: simplifyType(typePart), variant };
}

function countOccurrences(input: string, needle: string): number {
  let count = 0;
  let pos = input.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = input.indexOf(needle, pos + 1);
  }
  return count;
}

/** Parse `module::Type<Generics>` returning the consumed length, or undefined.
 *
 * Faithful to the upstream nom parser: when generics fail to parse, only the
 * identifier chain is consumed (the caller then sees leftover input and fails,
 * producing the `UnknownType::` fallback). */
function parseTypePath(input: string): string | undefined {
  let pos = parseTypeEntry(input);
  if (pos === 0) return undefined; // take_while1 failed on the first identifier
  return input.slice(0, pos);
}

/** Parse one identifier (alphanumeric + underscore); returns its length. */
function parseIdentifier(input: string): number | undefined {
  const match = /^[A-Za-z0-9_]+/.exec(input);
  if (match === null || match[0].length === 0) return undefined;
  return match[0].length;
}

/**
 * One `type_path_inner` alternative (upstream nom `type_path_inner`):
 * identifiers separated by `::`, plus optional generics. Never fails; a
 * 0-consumption result is meaningful for `separated_list0` guards.
 */
function parseTypeEntry(input: string): number {
  let pos = 0;
  for (;;) {
    const id = parseIdentifier(input.slice(pos));
    if (id === undefined) break;
    pos += id;
    if (input.slice(pos, pos + 2) !== '::') break;
    // A dangling `::` is not consumed when no identifier follows (nom backtrack).
    const nextId = parseIdentifier(input.slice(pos + 2));
    if (nextId === undefined) break;
    pos += 2;
  }
  // opt(generics): consumed only when a complete generics block parses.
  const genericLength = parseGenerics(input.slice(pos));
  if (genericLength !== undefined) pos += genericLength;
  return pos;
}

/**
 * Parse `<T, U>` generics exactly like the upstream nom combinators:
 * `<`, a `separated_list0` of entries separated by the literal `", "`, then
 * `>`. Element parsers that consume nothing terminate the list (nom's
 * empty-match guard); a trailing separator or malformed entry fails the
 * whole generics (undefined), never a partial consumption.
 */
function parseGenerics(input: string): number | undefined {
  if (!input.startsWith('<')) return undefined;
  let pos = 1;
  // separated_list0(", ", type_entry)
  const firstEntry = parseTypeEntry(input.slice(pos));
  if (firstEntry === undefined || firstEntry === 0) {
    pos += 0; // empty first element; the closing check below decides
  } else {
    pos += firstEntry;
    for (;;) {
      if (input.slice(pos, pos + 2) !== ', ') break;
      const nextEntry = parseTypeEntry(input.slice(pos + 2));
      if (nextEntry === undefined || nextEntry === 0) break; // backtrack before separator
      pos += 2 + nextEntry;
    }
  }
  if (input.slice(pos, pos + 1) !== '>') return undefined;
  return pos + 1;
}

/**
 * Simplify a type by removing module paths but keeping generic structure
 * (upstream `simplify_type` + `simplify_generics`).
 */
function simplifyType(typeStr: string): string {
  const genericStart = typeStr.indexOf('<');
  if (genericStart === -1) return lastSegment(typeStr);

  const base = typeStr.slice(0, genericStart);
  const typeName = base.includes('::') ? lastSegment(base) : base;
  return `${typeName}${simplifyGenerics(typeStr.slice(genericStart))}`;
}

function simplifyGenerics(genericsStr: string): string {
  if (!genericsStr.startsWith('<') || !genericsStr.endsWith('>')) return genericsStr;

  const inner = genericsStr.slice(1, -1);
  let result = '<';
  let depth = 0;
  let currentType = '';

  const flush = () => {
    const trimmed = currentType.trim();
    if (trimmed === '') return;
    if (!result.endsWith('<')) result += ', ';
    result += simplifyType(trimmed);
    currentType = '';
  };

  for (const ch of inner) {
    if (ch === '<') {
      depth++;
      currentType += ch;
    } else if (ch === '>') {
      depth--;
      currentType += ch;
    } else if (ch === ',' && depth === 0) {
      flush();
    } else {
      currentType += ch;
    }
  }
  flush();

  return `${result}>`;
}

// Imported late to avoid a cycle at module-eval time; type-knowledge owns the
// curated simplified names consulted by `displayName`.
import { getSimplifiedName } from './type-knowledge.js';
