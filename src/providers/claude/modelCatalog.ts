import type { ClaudeModelOption } from './cli';
import { CLAUDE_MODELS, type ClaudeEffort } from './protocol';

/** A model-picker entry: one Claude Code `--model` value with its display data and accepted efforts. */
export interface ClaudeModelEntry {
  value: string;
  name: string;
  description: string;
  detail: string;
  family: string;
  version: string;
  resolvedModel?: string;
  /** Explicit efforts the model accepts; undefined when it accepts no `--effort`. */
  efforts?: Array<Exclude<ClaudeEffort, 'auto'>>;
  /** An alias such as `opus` that follows the latest model, rather than a pinned model ID. */
  alias: boolean;
}

const EXPLICIT_EFFORTS: ReadonlyArray<Exclude<ClaudeEffort, 'auto'>> = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Aliases controlled by `modelBridge.claude.enabledModels`; anything else is controlled by `hiddenModels`. */
export const CLAUDE_ALIAS_IDS: ReadonlySet<string> = new Set(CLAUDE_MODELS.map((model) => model.id));

/**
 * Builds picker entries from Claude Code's model catalog, or from the built-in aliases when the catalog is
 * unavailable (older Claude Code, or a failed listing). Catalog order is kept: default, aliases, then pinned
 * versions, as Claude Code's own picker shows them.
 */
export function buildClaudeModelEntries(options: readonly ClaudeModelOption[] | undefined): ClaudeModelEntry[] {
  if (!options || options.length === 0) {
    return CLAUDE_MODELS.map((model) => ({
      value: model.id,
      name: model.name,
      description: model.description,
      detail: model.id === 'default' ? 'Model selected in Claude Code' : `Latest ${capitalize(model.id)}`,
      family: model.id === 'default' || model.id === 'best' ? 'claude' : `claude-${model.id}`,
      version: model.id,
      efforts: [...EXPLICIT_EFFORTS],
      alias: true
    }));
  }

  const entries = options.map((option): ClaudeModelEntry => {
    const alias = isAlias(option);
    const resolved = option.resolvedModel ?? option.value;
    const name = option.value === 'default'
      ? 'Claude Default'
      : `Claude ${option.displayName}${!alias && options.some((other) => isAlias(other) && other.displayName === option.displayName) ? ' (pinned)' : ''}`;
    return {
      value: option.value,
      name,
      description: option.description ?? option.displayName,
      detail: option.value === 'default'
        ? `Claude Code default · ${resolved}`
        : alias ? `Latest ${capitalize(option.value)} · ${resolved}` : resolved,
      family: familyOf(resolved),
      version: resolved,
      resolvedModel: option.resolvedModel,
      efforts: normalizeEfforts(option.effortLevels),
      alias
    };
  });

  // `best` is a Claude Code alias for Fable when the account has it, otherwise the latest Opus.
  if (!entries.some((entry) => entry.value === 'best')) {
    const target = entries.find((entry) => entry.value === 'fable') ?? entries.find((entry) => entry.value === 'opus');
    if (target) {
      const defaultIndex = entries.findIndex((entry) => entry.value === 'default');
      entries.splice(defaultIndex + 1, 0, {
        value: 'best',
        name: 'Claude Best',
        description: 'Uses Fable when available, otherwise the latest Opus model.',
        detail: `Fable or Opus · ${target.version}`,
        family: target.family,
        version: target.version,
        resolvedModel: target.resolvedModel,
        efforts: target.efforts,
        alias: true
      });
    }
  }
  return entries;
}

export function filterVisibleEntries(
  entries: readonly ClaudeModelEntry[],
  settings: { enabledModels: readonly string[]; hiddenModels: readonly string[] },
  unavailable: ReadonlySet<string>
): ClaudeModelEntry[] {
  const hidden = new Set(settings.hiddenModels);
  return entries.filter((entry) => !unavailable.has(entry.value)
    && !hidden.has(entry.value)
    && (!CLAUDE_ALIAS_IDS.has(entry.value) || settings.enabledModels.includes(entry.value)));
}

/** The effort to pass for a model: unsupported explicit efforts fall back to Claude Code's own default. */
export function resolveModelEffort(effort: ClaudeEffort, entry: ClaudeModelEntry | undefined): ClaudeEffort {
  if (effort === 'auto' || !entry) return effort;
  return entry.efforts?.includes(effort) ? effort : 'auto';
}

function isAlias(option: ClaudeModelOption): boolean {
  return !option.value.startsWith('claude-');
}

function normalizeEfforts(levels: readonly string[] | undefined): ClaudeModelEntry['efforts'] {
  if (!levels) return undefined;
  const efforts = EXPLICIT_EFFORTS.filter((effort) => levels.includes(effort));
  return efforts.length > 0 ? efforts : undefined;
}

function familyOf(model: string): string {
  const match = /claude-(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? `claude-${match[1].toLowerCase()}` : 'claude';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
