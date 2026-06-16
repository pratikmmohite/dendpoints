export interface ApiCall {
  filePath: string;
  line: number;
  column: number;
  method: string;
  url: string;
  snippet: string;
}

export interface ApiFileGroup {
  filePath: string;
  relativePath: string;
  calls: ApiCall[];
}
