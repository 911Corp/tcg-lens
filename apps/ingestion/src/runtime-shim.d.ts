declare const process: { env: Record<string,string|undefined>; argv: string[]; exit(code?: number): never };
declare const console: { log(...args:any[]):void; table(value:any):void };
declare const Buffer: { from(value: string, encoding: 'hex'): any };
declare module 'node:crypto' {
  export function createHash(algorithm: string): { update(data: string): any; digest(): any; digest(encoding:'hex'): string };
}
declare module 'node:fs/promises' { const fs: { readFile(path:string, encoding:'utf8'): Promise<string> }; export default fs; }
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
