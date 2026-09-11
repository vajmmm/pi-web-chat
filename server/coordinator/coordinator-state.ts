export interface CoordinatorSessionState {
  isExecuting: boolean;
}

export class CoordinatorStateTracker {
  private states = new Map<string, CoordinatorSessionState>();

  public getState(sessionId: string): CoordinatorSessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { isExecuting: false };
      this.states.set(sessionId, state);
    }
    return state;
  }

  public isActive(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state) return false;
    return state.isExecuting;
  }

  public turnStarted(sessionId: string): void {
    const state = this.getState(sessionId);
    state.isExecuting = true;
  }

  public turnEnded(sessionId: string): void {
    const state = this.getState(sessionId);
    state.isExecuting = false;
  }

  /** All session ids with an in-flight coordinator turn (busy parents). */
  public activeSessionIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, state] of this.states) {
      if (state.isExecuting) ids.push(sessionId);
    }
    return ids;
  }

  public clear(sessionId?: string): void {
    if (sessionId) {
      this.states.delete(sessionId);
    } else {
      this.states.clear();
    }
  }
}
