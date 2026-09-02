export interface CoordinatorSessionState {
  isExecuting: boolean;
  pendingReportsCount: number;
}

export class CoordinatorStateTracker {
  private states = new Map<string, CoordinatorSessionState>();

  public getState(sessionId: string): CoordinatorSessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { isExecuting: false, pendingReportsCount: 0 };
      this.states.set(sessionId, state);
    }
    return state;
  }

  public isActive(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state) return false;
    return state.isExecuting || state.pendingReportsCount > 0;
  }

  public isSafeBoundary(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state) return true;
    return !state.isExecuting && state.pendingReportsCount === 0;
  }

  public turnStarted(sessionId: string): void {
    const state = this.getState(sessionId);
    state.isExecuting = true;
  }

  public turnEnded(sessionId: string, options?: { hasPendingReports?: boolean }): void {
    const state = this.getState(sessionId);
    state.isExecuting = false;
    if (options?.hasPendingReports !== undefined) {
      state.pendingReportsCount = options.hasPendingReports ? Math.max(state.pendingReportsCount, 1) : 0;
    }
  }

  public reportPending(sessionId: string, countDelta: number = 1): void {
    const state = this.getState(sessionId);
    state.pendingReportsCount = Math.max(0, state.pendingReportsCount + countDelta);
  }

  public reportConsumed(sessionId: string): void {
    const state = this.getState(sessionId);
    state.pendingReportsCount = Math.max(0, state.pendingReportsCount - 1);
  }

  public clear(sessionId?: string): void {
    if (sessionId) {
      this.states.delete(sessionId);
    } else {
      this.states.clear();
    }
  }
}
