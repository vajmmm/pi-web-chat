import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { testAgentDir } from "./reliability/helpers.ts";
import {
  bindExistingSession,
  locateSession,
  SessionNotFoundError,
  sessionIdOf,
} from "../server/session/session-registry.ts";

void testAgentDir;

function sessionDirFor(cwd: string): string {
  const resolved = resolve(cwd);
  const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safePath);
}

function writeSessionFile(cwd: string, id: string): string {
  const dir = sessionDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: resolve(cwd),
    })}\n`,
  );
  return file;
}

describe("Session bind cwd isolation", () => {
  it("does not fall back to another cwd when an explicit project cwd is provided", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "pi-bind-project-"));
    const defaultCwd = mkdtempSync(join(tmpdir(), "pi-bind-webchat-"));
    const projectId = "sessproj001";
    const defaultId = "sesswebchat01";
    writeSessionFile(projectCwd, projectId);
    writeSessionFile(defaultCwd, defaultId);

    const fromProject = await locateSession(defaultId, projectCwd);
    assert.equal(fromProject, undefined, "must not pick a web-chat session when cwd is the project");

    const found = await locateSession(projectId, projectCwd);
    assert.ok(found);
    assert.equal(sessionIdOf(found.path), projectId);
    assert.equal(resolve(found.cwd), resolve(projectCwd));
  });

  it("finds an existing session by id when cwd is omitted instead of inventing a default-cwd session", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "pi-bind-scan-"));
    const id = "sessscan001";
    const path = writeSessionFile(projectCwd, id);

    const found = await locateSession(id);
    assert.ok(found);
    assert.equal(found.path, path);
    assert.equal(resolve(found.cwd), resolve(projectCwd));
  });

  it("refuses to bind a missing session id rather than creating a new one in the default cwd", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "pi-bind-missing-"));
    const defaultCwd = mkdtempSync(join(tmpdir(), "pi-bind-default-"));

    await assert.rejects(
      () => bindExistingSession("sessmissing01", projectCwd, defaultCwd),
      (err: unknown) => {
        assert.ok(err instanceof SessionNotFoundError);
        assert.match(err.message, /Session not found: sessmissing01/);
        return true;
      },
    );
  });
});
