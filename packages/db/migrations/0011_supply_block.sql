-- Live total supply. tokens.total_supply is the on-chain totalSupply() as of block supply_block; mints and
-- burns (Transfers from/to 0x0) after that block adjust it. Null = read at an unknown block (rows from
-- before this migration): left as-is until re-read (/admin/tokens/supply). Additive only.
ALTER TABLE "tokens" ADD COLUMN "supply_block" bigint;
