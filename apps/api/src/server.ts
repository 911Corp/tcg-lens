import Fastify from 'fastify';
import type { HeatSummary, MarketSummary, ResolutionInput } from '../../../packages/contracts/src/index.js';
import { resolve } from '../../../packages/resolution/src/index.js';
import { pool } from './db.js';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true, service: 'tcg-lens-api', version: '0.1.0' }));

app.post<{ Body: ResolutionInput }>('/v1/resolve', async (request) => resolve(request.body));

app.get<{ Params: { entityId: string } }>('/v1/market/:entityId', async (request): Promise<MarketSummary> => {
  if (!pool) return unavailableMarket(request.params.entityId);
  const { rows } = await pool.query(
    `SELECT currency,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY amount)::float8 AS low,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY amount)::float8 AS center,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY amount)::float8 AS high,
            max(observed_at) AS latest,
            count(*)::int AS observations
       FROM market_observations
      WHERE entity_id = $1
        AND observed_at > now() - interval '30 days'
        AND metric_type IN ('SALE','MARKET','TREND','LISTING_MEDIAN')
      GROUP BY currency
      ORDER BY observations DESC
      LIMIT 1`,
    [request.params.entityId]
  );
  if (!rows[0]) return unavailableMarket(request.params.entityId);
  const r = rows[0];
  const ageHours = (Date.now() - new Date(r.latest).getTime()) / 3_600_000;
  return {
    entityId: request.params.entityId,
    currency: r.currency,
    low: r.low,
    center: r.center,
    high: r.high,
    confidence: r.observations >= 10 ? 'HIGH' : r.observations >= 3 ? 'MEDIUM' : 'LOW',
    freshness: ageHours < 48 ? 'FRESH' : ageHours < 168 ? 'AGING' : 'STALE',
    computedAt: new Date().toISOString()
  };
});

app.get<{ Params: { entityId: string } }>('/v1/entities/:entityId/heat', async (request): Promise<HeatSummary> => {
  if (!pool) return unavailableHeat(request.params.entityId);
  const { rows } = await pool.query(
    `SELECT heat_score, demand_score, liquidity_score, momentum_score, heat_class, heat_trend, confidence
       FROM market_heat_snapshots
      WHERE entity_id = $1
      ORDER BY computed_at DESC
      LIMIT 1`,
    [request.params.entityId]
  );
  if (!rows[0]) return unavailableHeat(request.params.entityId);
  const r = rows[0];
  return {
    entityId: request.params.entityId,
    score: Number(r.heat_score),
    classification: normalizeHeatClass(r.heat_class),
    trend: normalizeHeatTrend(r.heat_trend),
    demandScore: nullableNumber(r.demand_score),
    liquidityScore: nullableNumber(r.liquidity_score),
    momentumScore: nullableNumber(r.momentum_score),
    confidence: r.confidence
  };
});

const port = Number(process.env.PORT ?? 8787);
app.listen({ port, host: '0.0.0.0' }).catch(err => {
  app.log.error(err);
  process.exit(1);
});

function unavailableMarket(entityId: string): MarketSummary {
  return { entityId, currency: 'EUR', confidence: 'INSUFFICIENT', freshness: 'UNAVAILABLE' };
}
function unavailableHeat(entityId: string): HeatSummary {
  return { entityId, classification: 'UNAVAILABLE', confidence: 'INSUFFICIENT' };
}
function nullableNumber(v: unknown): number | undefined { return v == null ? undefined : Number(v); }
function normalizeHeatClass(v: string): HeatSummary['classification'] {
  return ['FROZEN','COLD','COOL','WARM','HOT','SURGING'].includes(v) ? v as HeatSummary['classification'] : 'UNAVAILABLE';
}
function normalizeHeatTrend(v: string | null | undefined): HeatSummary['trend'] {
  return v && ['HEATING_FAST','HEATING','STABLE','COOLING','COOLING_FAST'].includes(v) ? v as HeatSummary['trend'] : undefined;
}
