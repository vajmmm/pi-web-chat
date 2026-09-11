import { spawnSync } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
}

/**
 * Returns a list of current processes with their PID, PPID, and PGID.
 */
function getProcessTable(): ProcessIdentity[] {
  try {
    const ps = spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (ps.error || ps.status !== 0 || !ps.stdout) {
      return [];
    }
    return ps.stdout
      .trim()
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
        return match
          ? [
              {
                pid: Number(match[1]),
                parent: Number(match[2]),
                group: Number(match[3]),
              },
            ]
          : [];
      });
  } catch {
    return [];
  }
}

/**
 * Finds all descendant PIDs for a given root PID.
 */
export function getDescendantPids(rootPid: number): number[] {
  const rows = getProcessTable();
  if (rows.length === 0 || !rootPid) return [];

  const found = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (found.has(row.parent) && !found.has(row.pid)) {
        found.add(row.pid);
        changed = true;
      }
    }
  }
  found.delete(rootPid);
  return Array.from(found);
}

/**
 * Sends a signal to the entire process group if running detached (negative PID),
 * or directly to the process and its descendants.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!Number.isInteger(pid) || pid <= 1) return;

  // Try sending to process group first (-pid)
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group signal may fail if not session leader; fallback to direct kill
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited
    }
  }
}

/**
 * Gracefully terminates a process tree:
 * 1. Sends SIGTERM to process group and all descendants.
 * 2. Waits up to gracePeriodMs.
 * 3. Sends SIGKILL to any surviving processes in the tree.
 */
export async function terminateProcessTree(
  rootPid: number,
  gracePeriodMs = 500,
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return;

  const descendants = getDescendantPids(rootPid);

  // Step 1: SIGTERM group
  signalProcessGroup(rootPid, "SIGTERM");
  for (const childPid of descendants) {
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      // Ignore already terminated
    }
  }

  // Step 2: Wait grace period
  await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));

  // Step 3: Check remaining and SIGKILL
  const survivingDescendants = getDescendantPids(rootPid);
  let rootAlive = false;
  try {
    process.kill(rootPid, 0);
    rootAlive = true;
  } catch {
    rootAlive = false;
  }

  if (rootAlive) {
    signalProcessGroup(rootPid, "SIGKILL");
  }
  for (const childPid of survivingDescendants) {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // Ignore
    }
  }
}
