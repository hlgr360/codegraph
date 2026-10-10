/**
 * pi coding agent target (https://pi.dev, `@earendil-works/pi-coding-agent`).
 * Writes:
 *
 *   - MCP server entry to `<agent-dir>/mcp.json` (global — the agent dir is
 *     `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`) or `./.pi/mcp.json`
 *     (local), under the standard `mcpServers.codegraph` key, with
 *     `exposure: "direct"`. Pi's default exposure is `codemode`: the tools
 *     are only reachable from a codemode script and are never declared to
 *     the model, so the agent would never call `codegraph_explore` as the
 *     tool it is meant to reach for first. `direct` declares it like a
 *     built-in tool.
 *   - The short marker-fenced CodeGraph block (#704) to pi's context file:
 *     pi does not put a direct server's MCP initialize instructions in front
 *     of the model, so this block is the only guidance it sees. Pi reads ONE
 *     context file per directory — the first of AGENTS.override.md,
 *     AGENTS.md, CLAUDE.md that exists — so the block goes into that file,
 *     and AGENTS.md is created only when none exists. Writing AGENTS.md
 *     beside an existing CLAUDE.md would shadow the user's own file.
 *
 * No permissions concept: pi gates tool calls through extensions, not an
 * allowlist in its config.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  writeJsonFile,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

/** The context files pi looks for in a directory, in the order it picks them. */
const CONTEXT_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

function configDir(loc: Location): string {
  if (loc !== 'global') return path.join(process.cwd(), '.pi');
  // Pi resolves its agent dir from PI_CODING_AGENT_DIR before ~/.pi/agent;
  // writing the default while pi reads the override would be a silent no-op.
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.pi', 'agent');
}
function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}
/** Global context files live in the agent dir; a project's at its root, not under `.pi/`. */
function contextDir(loc: Location): string {
  return loc === 'global' ? configDir('global') : process.cwd();
}
function instructionsPath(loc: Location): string {
  const dir = contextDir(loc);
  for (const name of CONTEXT_FILES) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* not there — try the next one */
    }
  }
  return path.join(dir, 'AGENTS.md');
}

export function getPiMcpServerConfig(): Record<string, unknown> {
  return {
    ...getMcpServerConfig(),
    exposure: 'direct',
    description: 'Code intelligence for this project: symbols, call paths and source from a pre-built index.',
  };
}

class PiTarget implements AgentTarget {
  readonly id = 'pi' as const;
  readonly displayName = 'pi';
  readonly docsUrl = 'https://pi.dev';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc), upsertInstructionsEntry(instructionsPath(loc))],
      notes: ['Run /reload in open pi sessions (or restart pi) to load codegraph.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    const instructions = instructionsPath(loc);
    files.push({
      path: instructions,
      action: removeMarkedSection(instructions, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END),
    });

    return { files };
  }

  printConfig(loc: Location): string {
    const snippet = JSON.stringify({ mcpServers: { codegraph: getPiMcpServerConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getPiMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const piTarget: AgentTarget = new PiTarget();
