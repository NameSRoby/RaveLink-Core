import type { Json, ModContext, ModDefinition } from "./index";

export interface TestHarnessOptions {
  modId?: string;
  startAt?: number;
  consumes?: string[];
  provides?: string[];
  providers?: Record<string, (payload: Json, context: { now(): number; providerId: string }) => Json | Promise<Json>>;
}
export interface ModTestHarness {
  readonly calls: Array<Record<string, unknown>>;
  readonly events: Array<Record<string, unknown>>;
  now(): number;
  advance(ms: number): number;
  start(): Promise<ModContext>;
  request(capability: string, method: string, payload: Json, signal?: AbortSignal): Promise<Json>;
  emit(capability: string, event: string, payload: Json): Promise<unknown>;
  stop(): Promise<void>;
}
export function createModTestHarness(mod: ModDefinition, options?: TestHarnessOptions): ModTestHarness;
