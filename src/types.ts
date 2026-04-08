export interface SessionInfo {
  name: string;
  index: number;
}

export interface SessionState {
  version: number;
  terminals: SessionInfo[];
}
