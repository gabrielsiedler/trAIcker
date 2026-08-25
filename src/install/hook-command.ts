import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the compiled hook, in the forward-slash form settings want.
 */
export function hookScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/install/*.ts -> dist/install/*.js, so the hook is one level up.
  return path.resolve(here, '..', 'hook.js').replace(/\\/g, '/');
}

/**
 * Shell command registered in Claude / Cursor settings.
 *
 * Always a direct node hook.js. On Windows, Cursor Agent feeds the payload
 * through a PowerShell $input pipe that never reaches Node's fd 0; hook.js
 * recovers by reading the temp cursor-hooks payload.json Cursor already wrote
 * (see readWindowsCursorTempPayload).
 */
export function hookCommand(hookScript: string): string {
  return `node "${hookScript}"`;
}
