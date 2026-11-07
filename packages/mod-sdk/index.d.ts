export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface CapabilityCallOptions { providerId?: string; timeoutMs?: number; }
export interface UiPanelContribution { id: string; title: string; entry: string; }
export interface ButtonActionContribution {
  id: string; title: string; description?: string; symbol?: string;
  capability: string; method: string; stateMethod?: string;
  defaults?: { [key: string]: Json }; parameters?: { [key: string]: Json };
}
export interface ModContributions { panels?: readonly UiPanelContribution[]; actions?: readonly ButtonActionContribution[]; }
export interface ModContext {
  readonly modId: string;
  readonly capabilities: readonly string[];
  readonly consumedCapabilities: readonly string[];
  callCapability(capability: string, method: string, payload?: Json, options?: CapabilityCallOptions): Promise<Json>;
  publishEvent(capability: string, event: string, payload?: Json): boolean | void;
  now?: () => number;
}
export interface ModRequest { capability: string; method: string; payload: Json; signal: AbortSignal; deadlineAt: number; }
export interface ModEvent { capability: string; event: string; payload: Json; }
export interface ModDefinition {
  activate(context: ModContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  handleRequest?(request: ModRequest): Json | Promise<Json>;
  handleEvent?(event: ModEvent): void | Promise<void>;
}
export interface CapabilityClient {
  call(capability: string, method: string, payload?: Json, options?: CapabilityCallOptions): Promise<Json>;
  publish(capability: string, event: string, payload?: Json): boolean | void;
}
export function defineMod(implementation: ModDefinition): Readonly<ModDefinition>;
export function createCapabilityClient(context: ModContext): CapabilityClient;
export function summarizeManifest(manifest: Record<string, unknown>): Readonly<Record<string, unknown>>;
