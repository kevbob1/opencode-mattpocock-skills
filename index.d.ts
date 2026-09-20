export interface SyncSkillsOptions {
  repository?: string;
  ref?: string;
  sourceDirectory?: string;
  exclude?: string[];
  updateIntervalHours?: number;
  gitTimeoutSeconds?: number;
  lockTimeoutSeconds?: number;
  cacheDirectory?: string;
  /** Internal/testing logger. Receives structured level, message, and details. */
  logger?: (entry: { level: "info" | "debug" | "warn" | "error"; message: string; [key: string]: unknown }) => void | Promise<void>;
}

export interface SyncSkillsResult {
  path: string;
  commit: string;
  updatedAt: string;
  updated: boolean;
}

export function syncSkills(options?: SyncSkillsOptions): Promise<SyncSkillsResult>;

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
  autoinvoke?: boolean;
}

export interface SkillEditor {
  add(skill: SkillInfo): void;
  list(): readonly SkillInfo[];
  get(id: string): SkillInfo | undefined;
  update(id: string, update: (skill: SkillInfo) => void): void;
  remove(id: string): void;
}

export interface PluginContext {
  options?: Omit<SyncSkillsOptions, "logger">;
  skill: {
    transform(callback: (editor: SkillEditor) => void): Promise<unknown>;
    reload(): Promise<void>;
    list(): Promise<readonly SkillInfo[]>;
  };
}

export interface PluginDefinition {
  id: string;
  setup(context: PluginContext): Promise<(() => void) | void>;
}

declare const mattPocockSkillsPlugin: PluginDefinition;
export default mattPocockSkillsPlugin;
