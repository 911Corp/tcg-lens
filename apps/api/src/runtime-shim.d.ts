declare const process: { env: Record<string,string|undefined>; exit(code?: number): never };

declare module 'fastify' {
  type RouteRequest<P = any, B = any> = { params: P; body: B };
  type Handler<T = any> = (request: RouteRequest<T extends { Params: infer P } ? P : any, T extends { Body: infer B } ? B : any>) => any;
  interface FastifyInstance {
    log: { error(error: unknown): void };
    get<T = any>(path: string, handler: Handler<T>): FastifyInstance;
    post<T = any>(path: string, handler: Handler<T>): FastifyInstance;
    listen(options: {port:number;host:string}): Promise<unknown>;
  }
  export default function Fastify(options?: unknown): FastifyInstance;
}

declare module 'pg' {
  class Pool {
    constructor(options?: { connectionString?: string });
    query(text: string, values?: unknown[]): Promise<{rows:any[]}>;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
