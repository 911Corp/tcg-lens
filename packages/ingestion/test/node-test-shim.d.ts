declare module 'node:assert/strict' { const assert: any; export default assert; }
declare module 'node:test' { const test: any; export default test; }
declare function structuredClone<T>(value: T): T;
