import type { FlagType } from '../evaluation/types.js';
import type { Json } from './json.js';

export const OPERATORS = [
  'eq', 'neq', 'in', 'not_in', 'starts_with', 'ends_with', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists',
  'semver_eq', 'semver_neq', 'semver_gt', 'semver_gte', 'semver_lt', 'semver_lte', 'before', 'after', 'in_segment', 'not_in_segment',
] as const;

export type Operator = (typeof OPERATORS)[number];

export type ConditionValue = string | number | boolean;

export interface Condition {
  readonly op: Operator;
  /** Null for the segment operators. */
  readonly attribute: string | null;
  readonly values: readonly ConditionValue[];
  readonly ignoreCase: boolean;
}

export interface ConditionGroup {
  readonly kind: 'all' | 'any';
  readonly members: readonly (Condition | ConditionGroup)[];
}

export interface Slot {
  readonly variation: string;
  readonly weight: number;
}

export interface FixedServe {
  readonly kind: 'fixed';
  readonly variation: string;
}

export interface RolloutServe {
  readonly kind: 'rollout';
  readonly bucketBy: string;
  readonly salt: string;
  readonly slots: readonly Slot[];
  readonly remainderVariation: string | null;
  readonly allocationId: string | null;
  readonly experimentId: string | null;
}

export type Serve = FixedServe | RolloutServe;

export interface Rule {
  readonly id: string;
  readonly enabled: boolean;
  readonly match: ConditionGroup;
  readonly serve: Serve;
}

export interface Prerequisite {
  readonly flagKey: string;
  readonly variations: readonly string[];
}

export interface Override {
  readonly kind: string;
  readonly key: string;
  readonly variation: string;
  /** Epoch milliseconds; null when the override never expires. */
  readonly expiresAtMs: number | null;
  readonly expiresAt: string | null;
}

export interface Flag {
  readonly key: string;
  readonly type: FlagType;
  readonly enabled: boolean;
  /** Variation key to value. Maps keep keys such as "__proto__" ordinary. */
  readonly variations: ReadonlyMap<string, Json>;
  readonly offVariation: string;
  readonly defaultVariation: string;
  readonly requires: readonly string[];
  readonly prerequisites: readonly Prerequisite[];
  readonly overrides: readonly Override[];
  readonly rules: readonly Rule[];
}

export interface SubjectRef {
  readonly kind: string;
  readonly key: string;
}

export interface Segment {
  readonly version: number;
  readonly match: ConditionGroup;
  readonly include: readonly SubjectRef[];
  readonly exclude: readonly SubjectRef[];
}

export interface Snapshot {
  readonly environment: { readonly id: string; readonly key: string };
  readonly revision: number;
  readonly generation: number;
  readonly projection: 'server' | 'public';
  readonly publishedAt: string;
  readonly requiredCapabilities: readonly string[];
  readonly flags: ReadonlyMap<string, Flag>;
  readonly segments: ReadonlyMap<string, Segment>;
  readonly checksum: string;
}

export const isGroup = (member: Condition | ConditionGroup): member is ConditionGroup => 'members' in member;

/** The capabilities of protocol version 1. */
export const CAPABILITIES = ['operators.v1', 'semver.v1', 'dates.v1', 'segments.v1', 'prerequisites.v1', 'rollouts.v1', 'experiments.v1'] as const;
