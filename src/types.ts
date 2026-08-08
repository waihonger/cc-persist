export interface SessionInfo {
  index: number;
  sessionId?: string;
  name?: string;
}

export interface SessionState {
  version: number;
  terminals: SessionInfo[];
}
