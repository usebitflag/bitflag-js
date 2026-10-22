import { parseInstant } from '../evaluation/values/instant.js';
import { parseSemVer } from '../evaluation/values/semver.js';
import { codePointLength, utf8Length } from '../evaluation/values/utf8.js';
import type { FlagType } from '../evaluation/types.js';
import { canonicalize } from './canonical.js';
import { verifyChecksum } from './checksum.js';
import { MalformedSnapshot, Problem, type ProblemCode } from './errors.js';
import { decodeJson, isObject, isUnsafeNumber, MAX_SAFE_INTEGER, type Json } from './json.js';
import {
  OPERATORS,
  type Condition,
  type ConditionGroup,
  type ConditionValue,
  type Flag,
  type Operator,
  type Override,
  type Prerequisite,
  type Rule,
  type Segment,
  type Serve,
  type Slot,
  type Snapshot,
  type SubjectRef,
} from './model.js';

const MAX_RULES = 200;
const MAX_OVERRIDES = 500;
const MAX_PREREQUISITES = 20;
const MAX_MEMBERS = 50;
const MAX_VALUES = 1000;
const MAX_SEGMENT_KEYS = 50;
const MAX_GROUP_DEPTH = 5;
const MAX_JSON_VALUE_BYTES = 32 * 1024;

const FLAG_KEY = /^[a-z][a-z0-9_-]{0,99}$/;
const VARIATION_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CONTEXT_KIND = /^[a-z][a-z0-9_-]{0,63}$/;
const CAPABILITY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.v[1-9][0-9]*$/;
const ENV_ID = /^env_[A-Za-z0-9]{1,60}$/;
const ENV_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;

type JsonObject = { [key: string]: Json };

const escapeKey = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

function fail(path: string, problem: ProblemCode, detail = ''): MalformedSnapshot {
  return MalformedSnapshot.malformed(path, problem, detail);
}

/**
 * Turns snapshot JSON into a Snapshot, or rejects it. Checks everything the schema says and the rules JSON Schema
 * cannot express, except references between flags, segments and variations (see `validateSnapshot`).
 *
 * @throws MalformedSnapshot
 */
export function parseSnapshot(text: string, options: { verifyChecksum?: boolean } = {}): Snapshot {
  return snapshotFromJson(decodeJson(text), options);
}

/** @throws MalformedSnapshot */
export function snapshotFromJson(root: Json, options: { verifyChecksum?: boolean } = {}): Snapshot {
  if (!isObject(root)) {
    throw fail('', Problem.INVALID_TYPE);
  }
  checkVersions(root);
  rejectUnsafeNumbers(root, '');

  const m = members(root, '', ['protocolVersion', 'algorithmVersion', 'environment', 'revision', 'generation', 'projection', 'publishedAt', 'requiredCapabilities', 'flags', 'segments', 'checksum']);

  const environment = readEnvironment(m.environment);
  const revision = readInteger(m.revision, '/revision', 0);
  const generation = readInteger(m.generation, '/generation', 1);
  const projectionName = readString(m.projection, '/projection');
  if (projectionName !== 'server' && projectionName !== 'public') {
    throw fail('/projection', Problem.INVALID_VALUE);
  }
  const projection = projectionName;
  const publishedAt = readString(m.publishedAt, '/publishedAt');
  if (parseInstant(publishedAt, true) === null) {
    throw fail('/publishedAt', Problem.INVALID_VALUE, 'not an RFC 3339 instant in UTC');
  }
  const requiredCapabilities = readCapabilities(m.requiredCapabilities, '/requiredCapabilities');
  const checksum = readString(m.checksum, '/checksum');
  if (!CHECKSUM.test(checksum)) {
    throw fail('/checksum', Problem.INVALID_VALUE);
  }

  const flagsNode = readObject(m.flags, '/flags');
  if (revision === 0 && Object.keys(flagsNode).length > 0) {
    throw fail('/flags', Problem.EMPTY_SNAPSHOT_REQUIRED);
  }
  const flags = new Map<string, Flag>();
  for (const [key, node] of Object.entries(flagsNode)) {
    if (!FLAG_KEY.test(key)) {
      throw fail(`/flags/${escapeKey(key)}`, Problem.INVALID_VALUE, 'invalid flag key');
    }
    flags.set(key, readFlag(key, node, `/flags/${escapeKey(key)}`, projection));
  }

  const segmentsNode = readObject(m.segments, '/segments');
  const segments = new Map<string, Segment>();
  for (const [key, node] of Object.entries(segmentsNode)) {
    if (!FLAG_KEY.test(key)) {
      throw fail(`/segments/${escapeKey(key)}`, Problem.INVALID_VALUE, 'invalid segment key');
    }
    segments.set(key, readSegment(node, `/segments/${escapeKey(key)}`, projection));
  }

  if (options.verifyChecksum !== false) {
    verifyChecksum(root);
  }

  return { environment, revision, generation, projection, publishedAt, requiredCapabilities, flags, segments, checksum };
}

function checkVersions(root: JsonObject): void {
  if ('protocolVersion' in root) {
    const version = root.protocolVersion;
    if (typeof version !== 'number') {
      throw fail('/protocolVersion', Problem.INVALID_TYPE);
    }
    if (version !== 1) {
      throw fail('/protocolVersion', Problem.UNSUPPORTED_VERSION);
    }
  }
  if ('algorithmVersion' in root) {
    const algorithm = root.algorithmVersion;
    if (typeof algorithm !== 'string') {
      throw fail('/algorithmVersion', Problem.INVALID_TYPE);
    }
    if (algorithm !== 'bucket-sha256-v1') {
      throw new MalformedSnapshot('UNSUPPORTED_CAPABILITY', '/algorithmVersion', Problem.UNSUPPORTED_ALGORITHM);
    }
  }
}

function rejectUnsafeNumbers(node: Json, path: string): void {
  if (typeof node === 'number') {
    if (isUnsafeNumber(node)) {
      throw fail(path, Problem.UNSAFE_NUMBER);
    }
  } else if (Array.isArray(node)) {
    node.forEach((child, index) => {
      rejectUnsafeNumbers(child, `${path}/${String(index)}`);
    });
  } else if (isObject(node)) {
    for (const [name, child] of Object.entries(node)) {
      rejectUnsafeNumbers(child, `${path}/${escapeKey(name)}`);
    }
  }
}

function readEnvironment(node: Json | undefined): Snapshot['environment'] {
  const m = members(readObject(node, '/environment'), '/environment', ['id', 'key']);
  const id = readString(m.id, '/environment/id');
  const key = readString(m.key, '/environment/key');
  if (!ENV_ID.test(id)) {
    throw fail('/environment/id', Problem.INVALID_VALUE);
  }
  if (!ENV_KEY.test(key)) {
    throw fail('/environment/key', Problem.INVALID_VALUE);
  }
  return { id, key };
}

function readCapabilities(node: Json | undefined, path: string): string[] {
  const out: string[] = [];
  readList(node, path).forEach((item, index) => {
    const name = readString(item, `${path}/${String(index)}`);
    if (!CAPABILITY.test(name) || out.includes(name)) {
      throw fail(`${path}/${String(index)}`, Problem.INVALID_VALUE, 'invalid or repeated capability');
    }
    out.push(name);
  });
  return out;
}

function readFlag(key: string, node: Json | undefined, path: string, projection: 'server' | 'public'): Flag {
  const m = members(
    readObject(node, path),
    path,
    ['type', 'enabled', 'variations', 'offVariation', 'defaultVariation', 'prerequisites', 'overrides', 'rules', 'requires'],
    ['requires'],
  );

  const typeName = readString(m.type, `${path}/type`);
  if (typeName !== 'boolean' && typeName !== 'string' && typeName !== 'number' && typeName !== 'json') {
    throw fail(`${path}/type`, Problem.INVALID_VALUE);
  }
  const type: FlagType = typeName;
  const enabled = readBoolean(m.enabled, `${path}/enabled`);
  const variations = readVariations(m.variations, `${path}/variations`, type);
  const offVariation = readVariationKey(m.offVariation, `${path}/offVariation`);
  const defaultVariation = readVariationKey(m.defaultVariation, `${path}/defaultVariation`);
  const requires = m.requires === undefined ? [] : readCapabilities(m.requires, `${path}/requires`);

  const prerequisiteNodes = readList(m.prerequisites, `${path}/prerequisites`);
  if (prerequisiteNodes.length > MAX_PREREQUISITES) {
    throw fail(`${path}/prerequisites`, Problem.LIMIT_EXCEEDED);
  }
  const prerequisites = prerequisiteNodes.map((item, index) => readPrerequisite(item, `${path}/prerequisites/${String(index)}`));

  const overrideNodes = readList(m.overrides, `${path}/overrides`);
  if (overrideNodes.length > MAX_OVERRIDES) {
    throw fail(`${path}/overrides`, Problem.LIMIT_EXCEEDED);
  }
  if (projection === 'public' && overrideNodes.length > 0) {
    throw fail(`${path}/overrides`, Problem.PROJECTION_VIOLATION);
  }
  const seen = new Set<string>();
  const overrides = overrideNodes.map((item, index) => {
    const override = readOverride(item, `${path}/overrides/${String(index)}`);
    const identity = JSON.stringify([override.kind, override.key]);
    if (seen.has(identity)) {
      throw fail(`${path}/overrides/${String(index)}`, Problem.DUPLICATE_OVERRIDE);
    }
    seen.add(identity);
    return override;
  });

  const ruleNodes = readList(m.rules, `${path}/rules`);
  if (ruleNodes.length > MAX_RULES) {
    throw fail(`${path}/rules`, Problem.LIMIT_EXCEEDED);
  }
  const rules = ruleNodes.map((item, index) => readRule(item, `${path}/rules/${String(index)}`));

  return { key, type, enabled, variations, offVariation, defaultVariation, requires, prerequisites, overrides, rules };
}

function readVariations(node: Json | undefined, path: string, type: FlagType): Map<string, Json> {
  const object = readObject(node, path);
  const entries = Object.entries(object);
  if (entries.length === 0) {
    throw fail(path, Problem.INVALID_VALUE, 'a flag needs at least one variation');
  }

  const out = new Map<string, Json>();
  for (const [key, value] of entries) {
    const valuePath = `${path}/${escapeKey(key)}`;
    if (!VARIATION_KEY.test(key)) {
      throw fail(valuePath, Problem.INVALID_VALUE, 'invalid variation key');
    }
    const valid =
      type === 'boolean' ? typeof value === 'boolean' : type === 'string' ? typeof value === 'string' : type === 'number' ? typeof value === 'number' : true;
    if (!valid) {
      throw fail(valuePath, Problem.INVALID_TYPE, 'the value does not match the flag type');
    }
    if (type === 'json' && utf8Length(canonicalize(value)) > MAX_JSON_VALUE_BYTES) {
      throw fail(valuePath, Problem.LIMIT_EXCEEDED, 'a json value is at most 32 KB');
    }
    out.set(key, value);
  }
  return out;
}

function readPrerequisite(node: Json | undefined, path: string): Prerequisite {
  const m = members(readObject(node, path), path, ['flagKey', 'variations']);
  const flagKey = readString(m.flagKey, `${path}/flagKey`);
  if (!FLAG_KEY.test(flagKey)) {
    throw fail(`${path}/flagKey`, Problem.INVALID_VALUE);
  }
  const items = readList(m.variations, `${path}/variations`);
  if (items.length === 0) {
    throw fail(`${path}/variations`, Problem.INVALID_VALUE);
  }
  const variations: string[] = [];
  items.forEach((item, index) => {
    const variation = readVariationKey(item, `${path}/variations/${String(index)}`);
    if (variations.includes(variation)) {
      throw fail(`${path}/variations/${String(index)}`, Problem.INVALID_VALUE, 'repeated variation');
    }
    variations.push(variation);
  });
  return { flagKey, variations };
}

function readOverride(node: Json | undefined, path: string): Override {
  const m = members(readObject(node, path), path, ['kind', 'key', 'variation', 'expiresAt']);
  const kind = readString(m.kind, `${path}/kind`);
  if (!CONTEXT_KIND.test(kind)) {
    throw fail(`${path}/kind`, Problem.INVALID_VALUE);
  }
  const key = readString(m.key, `${path}/key`);
  const keyBytes = utf8Length(key);
  if (keyBytes < 1 || keyBytes > 256) {
    throw fail(`${path}/key`, Problem.INVALID_VALUE, 'a key is 1 to 256 bytes');
  }
  const variation = readVariationKey(m.variation, `${path}/variation`);
  if (m.expiresAt === null) {
    return { kind, key, variation, expiresAtMs: null, expiresAt: null };
  }
  const expiresAt = readString(m.expiresAt, `${path}/expiresAt`);
  const expiresAtMs = parseInstant(expiresAt);
  if (expiresAtMs === null) {
    throw fail(`${path}/expiresAt`, Problem.INVALID_VALUE, 'not an RFC 3339 instant');
  }
  return { kind, key, variation, expiresAtMs, expiresAt };
}

function readRule(node: Json | undefined, path: string): Rule {
  const m = members(readObject(node, path), path, ['id', 'enabled', 'match', 'serve'], ['enabled']);
  const id = readString(m.id, `${path}/id`);
  const length = codePointLength(id);
  if (length < 1 || length > 64) {
    throw fail(`${path}/id`, Problem.INVALID_VALUE, 'a rule ID is 1 to 64 characters');
  }
  const enabled = m.enabled === undefined ? true : readBoolean(m.enabled, `${path}/enabled`);
  return { id, enabled, match: readGroup(m.match, `${path}/match`, 1), serve: readServe(m.serve, `${path}/serve`) };
}

function readGroup(node: Json | undefined, path: string, depth: number): ConditionGroup {
  const object = readObject(node, path);
  if (depth > MAX_GROUP_DEPTH) {
    throw fail(path, Problem.LIMIT_EXCEEDED, 'groups nest at most 5 levels');
  }

  const names = Object.keys(object);
  for (const name of names) {
    if (name !== 'all' && name !== 'any') {
      throw fail(`${path}/${escapeKey(name)}`, Problem.UNKNOWN_FIELD);
    }
  }
  if (names.length === 0) {
    throw fail(path, Problem.MISSING_FIELD, 'a group has all or any');
  }
  if (names.length > 1) {
    throw fail(path, Problem.INVALID_VALUE, 'a group has all or any, not both');
  }

  const kind = names[0] === 'any' ? 'any' : 'all';
  const items = readList(object[kind], `${path}/${kind}`);
  if (items.length > MAX_MEMBERS) {
    throw fail(`${path}/${kind}`, Problem.LIMIT_EXCEEDED, 'a group has at most 50 members');
  }

  const out = items.map((item, index) => {
    const itemPath = `${path}/${kind}/${String(index)}`;
    const itemObject = readObject(item, itemPath);
    return 'all' in itemObject || 'any' in itemObject ? readGroup(itemObject, itemPath, depth + 1) : readCondition(itemObject, itemPath);
  });
  return { kind, members: out };
}

function readCondition(node: JsonObject, path: string): Condition {
  const m = members(node, path, ['attribute', 'op', 'values', 'ignoreCase'], ['attribute', 'values', 'ignoreCase']);
  if (m.op === undefined) {
    throw fail(path, Problem.MISSING_FIELD, 'a condition has an operator');
  }
  const opName = readString(m.op, `${path}/op`);
  const op = OPERATORS.find((candidate) => candidate === opName);
  if (op === undefined) {
    throw fail(`${path}/op`, Problem.INVALID_VALUE, 'unknown operator');
  }

  let attribute: string | null = null;
  if (op === 'in_segment' || op === 'not_in_segment') {
    if (m.attribute !== undefined) {
      throw fail(`${path}/attribute`, Problem.INVALID_VALUE, 'a segment condition has no attribute');
    }
  } else {
    if (m.attribute === undefined) {
      throw fail(path, Problem.MISSING_FIELD, 'a condition names an attribute');
    }
    attribute = readString(m.attribute, `${path}/attribute`);
    const bytes = utf8Length(attribute);
    if (bytes < 1 || bytes > 128) {
      throw fail(`${path}/attribute`, Problem.INVALID_VALUE, 'an attribute name is 1 to 128 bytes');
    }
  }
  const ignoreCase = m.ignoreCase === undefined ? false : readBoolean(m.ignoreCase, `${path}/ignoreCase`);

  if (op === 'exists' || op === 'not_exists') {
    if (m.values !== undefined) {
      throw fail(`${path}/values`, Problem.INVALID_VALUE, 'exists and not_exists take no values');
    }
    return { op, attribute, values: [], ignoreCase };
  }
  if (m.values === undefined) {
    throw fail(path, Problem.MISSING_FIELD, 'a condition lists values');
  }
  return { op, attribute, values: readConditionValues(op, m.values, `${path}/values`), ignoreCase };
}

const SINGLE_VALUE: readonly Operator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'semver_eq', 'semver_neq', 'semver_gt', 'semver_gte', 'semver_lt', 'semver_lte', 'before', 'after'];
const NUMERIC: readonly Operator[] = ['gt', 'gte', 'lt', 'lte'];
const STRING_VALUED: readonly Operator[] = ['starts_with', 'ends_with', 'contains', 'semver_eq', 'semver_neq', 'semver_gt', 'semver_gte', 'semver_lt', 'semver_lte', 'before', 'after', 'in_segment', 'not_in_segment'];

function readConditionValues(op: Operator, node: Json, path: string): ConditionValue[] {
  const items = readList(node, path);
  const segment = op === 'in_segment' || op === 'not_in_segment';
  if (items.length > (segment ? MAX_SEGMENT_KEYS : MAX_VALUES)) {
    throw fail(path, Problem.LIMIT_EXCEEDED);
  }
  if (items.length === 0) {
    throw fail(path, Problem.INVALID_VALUE, 'a condition lists at least one value');
  }
  if (SINGLE_VALUE.includes(op) && items.length !== 1) {
    throw fail(path, Problem.INVALID_VALUE, 'this operator takes exactly one value');
  }

  const out: ConditionValue[] = [];
  let family: 'string' | 'number' | null = null;
  items.forEach((item, index) => {
    const itemPath = `${path}/${String(index)}`;
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw fail(itemPath, Problem.INVALID_TYPE, 'a value is a string, number or boolean');
    }
    if (NUMERIC.includes(op)) {
      if (typeof item !== 'number') {
        throw fail(itemPath, Problem.INVALID_TYPE);
      }
    } else if (STRING_VALUED.includes(op)) {
      if (typeof item !== 'string') {
        throw fail(itemPath, Problem.INVALID_TYPE);
      }
      if (op.startsWith('semver_') && parseSemVer(item) === null) {
        throw fail(itemPath, Problem.INVALID_VALUE, 'not a valid SemVer');
      }
      if ((op === 'before' || op === 'after') && parseInstant(item) === null) {
        throw fail(itemPath, Problem.INVALID_VALUE, 'not an RFC 3339 instant');
      }
      if (segment && !FLAG_KEY.test(item)) {
        throw fail(itemPath, Problem.INVALID_VALUE, 'not a segment key');
      }
    } else if (op === 'in' || op === 'not_in') {
      if (typeof item === 'boolean') {
        throw fail(itemPath, Problem.INVALID_TYPE);
      }
      const itemFamily = typeof item === 'string' ? 'string' : 'number';
      if (family !== null && family !== itemFamily) {
        throw fail(itemPath, Problem.INVALID_TYPE, 'the values of in and not_in have one type');
      }
      family = itemFamily;
    }
    out.push(item);
  });
  return out;
}

function readServe(node: Json | undefined, path: string): Serve {
  const object = readObject(node, path);
  const names = Object.keys(object);
  for (const name of names) {
    if (name !== 'variation' && name !== 'rollout') {
      throw fail(`${path}/${escapeKey(name)}`, Problem.UNKNOWN_FIELD);
    }
  }
  if (names.length === 0) {
    throw fail(path, Problem.MISSING_FIELD, 'serve has variation or rollout');
  }
  if (names.length > 1) {
    throw fail(path, Problem.INVALID_VALUE, 'serve has variation or rollout, not both');
  }
  if (object.variation !== undefined) {
    return { kind: 'fixed', variation: readVariationKey(object.variation, `${path}/variation`) };
  }
  return readRollout(object.rollout, `${path}/rollout`);
}

function readRollout(node: Json | undefined, path: string): Serve {
  const m = members(
    readObject(node, path),
    path,
    ['bucketBy', 'salt', 'slots', 'remainderVariation', 'allocationId', 'experimentId'],
    ['remainderVariation', 'allocationId', 'experimentId'],
  );

  const bucketBy = readString(m.bucketBy, `${path}/bucketBy`);
  const bucketByBytes = utf8Length(bucketBy);
  if (bucketByBytes < 1 || bucketByBytes > 128) {
    throw fail(`${path}/bucketBy`, Problem.INVALID_VALUE);
  }
  const salt = readString(m.salt, `${path}/salt`);
  const saltBytes = utf8Length(salt);
  if (saltBytes < 1 || saltBytes > 128) {
    throw fail(`${path}/salt`, Problem.INVALID_VALUE, 'a salt is 1 to 128 bytes');
  }

  const slotNodes = readList(m.slots, `${path}/slots`);
  if (slotNodes.length === 0) {
    throw fail(`${path}/slots`, Problem.INVALID_VALUE, 'a rollout has at least one slot');
  }
  let total = 0;
  const slots: Slot[] = slotNodes.map((slotNode, index) => {
    const slotPath = `${path}/slots/${String(index)}`;
    const sm = members(readObject(slotNode, slotPath), slotPath, ['variation', 'weight']);
    const weight = readInteger(sm.weight, `${slotPath}/weight`, 0, 100000);
    total += weight;
    return { variation: readVariationKey(sm.variation, `${slotPath}/variation`), weight };
  });

  const remainderVariation = m.remainderVariation === undefined ? null : readVariationKey(m.remainderVariation, `${path}/remainderVariation`);
  const allocationId = m.allocationId === undefined ? null : readIdentifier(m.allocationId, `${path}/allocationId`);
  const experimentId = m.experimentId === undefined ? null : readIdentifier(m.experimentId, `${path}/experimentId`);
  if ((allocationId === null) !== (experimentId === null)) {
    throw fail(path, Problem.MISSING_FIELD, 'allocationId and experimentId come together');
  }
  if (total > 100000) {
    throw fail(`${path}/slots`, Problem.WEIGHT_TOTAL_EXCEEDED);
  }
  if (total < 100000 && remainderVariation === null) {
    throw fail(path, Problem.MISSING_REMAINDER);
  }
  return { kind: 'rollout', bucketBy, salt, slots, remainderVariation, allocationId, experimentId };
}

function readSegment(node: Json | undefined, path: string, projection: 'server' | 'public'): Segment {
  const m = members(readObject(node, path), path, ['version', 'match', 'include', 'exclude'], ['include', 'exclude']);
  const lists: Record<'include' | 'exclude', SubjectRef[]> = { include: [], exclude: [] };
  for (const name of ['include', 'exclude'] as const) {
    const list = m[name];
    if (list === undefined) {
      continue;
    }
    if (projection === 'public') {
      throw fail(`${path}/${name}`, Problem.PROJECTION_VIOLATION);
    }
    lists[name] = readList(list, `${path}/${name}`).map((item, index) => readSubject(item, `${path}/${name}/${String(index)}`));
  }
  return { version: readInteger(m.version, `${path}/version`, 1), match: readGroup(m.match, `${path}/match`, 1), include: lists.include, exclude: lists.exclude };
}

function readSubject(node: Json | undefined, path: string): SubjectRef {
  const m = members(readObject(node, path), path, ['kind', 'key']);
  const kind = readString(m.kind, `${path}/kind`);
  if (!CONTEXT_KIND.test(kind)) {
    throw fail(`${path}/kind`, Problem.INVALID_VALUE);
  }
  const key = readString(m.key, `${path}/key`);
  const bytes = utf8Length(key);
  if (bytes < 1 || bytes > 256) {
    throw fail(`${path}/key`, Problem.INVALID_VALUE);
  }
  return { kind, key };
}

// Primitive readers

/** The members of an object, checked against the allowed names and the required ones. */
function members(object: JsonObject, path: string, allowed: readonly string[], optional: readonly string[] = []): Record<string, Json | undefined> {
  for (const name of Object.keys(object)) {
    if (!allowed.includes(name)) {
      throw fail(`${path}/${escapeKey(name)}`, Problem.UNKNOWN_FIELD);
    }
  }
  for (const name of allowed) {
    if (!(name in object) && !optional.includes(name)) {
      throw fail(path, Problem.MISSING_FIELD, `missing "${name}"`);
    }
  }
  return object;
}

function readObject(node: Json | undefined, path: string): JsonObject {
  if (node === undefined || !isObject(node)) {
    throw fail(path, Problem.INVALID_TYPE, 'expected an object');
  }
  return node;
}

function readList(node: Json | undefined, path: string): Json[] {
  if (!Array.isArray(node)) {
    throw fail(path, Problem.INVALID_TYPE, 'expected an array');
  }
  return node;
}

function readString(node: Json | undefined, path: string): string {
  if (typeof node !== 'string') {
    throw fail(path, Problem.INVALID_TYPE, 'expected a string');
  }
  return node;
}

function readBoolean(node: Json | undefined, path: string): boolean {
  if (typeof node !== 'boolean') {
    throw fail(path, Problem.INVALID_TYPE, 'expected a boolean');
  }
  return node;
}

function readInteger(node: Json | undefined, path: string, min: number, max?: number): number {
  if (typeof node !== 'number' || !Number.isInteger(node) || Math.abs(node) > MAX_SAFE_INTEGER) {
    throw fail(path, Problem.INVALID_TYPE, 'expected an integer');
  }
  if (node < min || (max !== undefined && node > max)) {
    throw fail(path, Problem.INVALID_VALUE, 'out of range');
  }
  return node;
}

function readVariationKey(node: Json | undefined, path: string): string {
  const key = readString(node, path);
  if (!VARIATION_KEY.test(key)) {
    throw fail(path, Problem.INVALID_VALUE, 'invalid variation key');
  }
  return key;
}

function readIdentifier(node: Json | undefined, path: string): string {
  const value = readString(node, path);
  const length = codePointLength(value);
  if (length < 1 || length > 64) {
    throw fail(path, Problem.INVALID_VALUE, 'an ID is 1 to 64 characters');
  }
  return value;
}
