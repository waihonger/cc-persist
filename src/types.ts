export interface SessionInfo {
  index: number;
  sessionId: string;
  name?: string;
  cwd?: string;
}

export interface SessionState {
  version: 2;
  terminals: SessionInfo[];
}
