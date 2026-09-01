# Sakhal runtime placement export

This mission scans the complete 15,360 m Sakhal world without initializing
the Hive or Central Economy. It writes files beneath the server profile:

- `sakhal-placement-row-N.tsv`: shape paths and complete transforms for one
  scan row. Row segmentation limits data loss if the server exits early.
- `sakhal-placement-summary.tsv`: final totals and counts by shape.

The scan uses overlapping 150 m queries on a 200 m grid. Each placement is
assigned to its nearest query center, which prevents duplicates without keeping
millions of keys in memory. The summary separately reports roads and vegetation.
