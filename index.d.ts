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

declare function mattPocockSkillsPlugin(input: { client: { app: { log(input: { body: Record<string, unknown> }): unknown } } }, options?: Omit<SyncSkillsOptions, "logger">): Promise<{
  config(config: { skills?: { paths?: string[] } }): Promise<void>;
}>;

export default mattPocockSkillsPlugin;
