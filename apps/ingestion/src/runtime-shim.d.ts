declare const process: { env: Record<string,string|undefined>; argv: string[]; exit(code?: number): never };
declare const console: { log(...args:any[]):void; error(...args:any[]):void; table(value:any):void };
declare const Buffer: { from(value: string, encoding: 'hex'): any };
declare module 'node:crypto' {
  export function createHash(algorithm: string): { update(data: string): any; digest(): any; digest(encoding:'hex'): string };
}
declare module 'node:fs/promises' {
  const fs: {
    readFile(path:string, encoding:'utf8'): Promise<string>;
    writeFile(path:string, data:string): Promise<void>;
    mkdir(path:string, options?:{ recursive?: boolean }): Promise<unknown>;
    readdir(path:string): Promise<string[]>;
  };
  export default fs;
}
declare module 'node:path' {
  const path: { resolve(...parts:string[]): string; join(...parts:string[]): string; dirname(p:string): string; basename(p:string): string };
  export default path;
}
declare module 'pg' {
  export class Pool {
    constructor(options:any);
    query(text:string, values?:any[]):Promise<any>;
    connect():Promise<any>;
    end():Promise<void>;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
declare function setTimeout(cb: (...args:any[]) => void, ms?: number): any;
declare module 'node:child_process' {
  export function execFileSync(file: string, args?: string[], options?: { env?: Record<string, string | undefined>; stdio?: string }): { toString(): string };
}
declare module 'node:assert/strict' { const assert: any; export default assert; }
