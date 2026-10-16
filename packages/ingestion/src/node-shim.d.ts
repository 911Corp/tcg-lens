declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string, inputEncoding?: string): any;
    digest(encoding: 'hex'): string;
  };
}
