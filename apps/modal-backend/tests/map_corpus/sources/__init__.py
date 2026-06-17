"""Source adapters that FIND free-to-use reference imagery online and emit corpus
manifest rows (id, tier, source_url, license_note, attribution, filename). They
only add rows; `make corpus-fetch` then downloads + sha-pins the binaries, exactly
as for the hand-seeded maps."""
