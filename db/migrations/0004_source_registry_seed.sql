BEGIN;

INSERT INTO data_sources(source_code, display_name, source_kind, access_mode, base_url)
VALUES
 ('pokemon_jp','Pokémon Card Game Japan','OFFICIAL','WEB','https://www.pokemon-card.com'),
 ('pokemon_official_west','Pokémon TCG Official','OFFICIAL','WEB','https://www.pokemon.com'),
 ('tcgdex','TCGdex','DATA_PROVIDER','API','https://tcgdex.dev'),
 ('cardmarket','Cardmarket','MARKETPLACE','PUBLIC_DOWNLOADS','https://www.cardmarket.com'),
 ('tcgplayer','TCGplayer','MARKETPLACE','INDIRECT','https://www.tcgplayer.com'),
 ('tcgcsv','TCGCSV','DATA_PROVIDER','PUBLIC_DOWNLOADS','https://tcgcsv.com'),
 ('cardtrader','CardTrader','MARKETPLACE','API','https://www.cardtrader.com'),
 ('ebay','eBay','MARKETPLACE','API','https://www.ebay.com'),
 ('ptcg_database','PTCG Database','AGGREGATOR','PUBLIC_REPOSITORY','https://github.com/type-null/PTCG-database'),
 ('internal_verified','TCG Lens Internal Verified','INTERNAL','INTERNAL',NULL),
 ('user_observation','User Observation','USER_OBSERVATION','RUNTIME',NULL)
ON CONFLICT (source_code) DO NOTHING;

INSERT INTO market_venues(venue_code, display_name, region_code)
VALUES
 ('cardmarket','Cardmarket','EU'),
 ('tcgplayer','TCGplayer','US'),
 ('cardtrader','CardTrader',NULL),
 ('ebay','eBay',NULL)
ON CONFLICT (venue_code) DO NOTHING;

COMMIT;
