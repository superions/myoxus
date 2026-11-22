-- Historical workspace aggregates contain no user identities. Only a minute
-- with at most one nonempty workspace has an exact cluster-wide count.
INSERT INTO metrics_raw(minute, category, metric_name, labels, value)
SELECT bucket_at,'collab','active_sync_users','{}',MAX(active_users)
FROM workspace_analytics_minute WHERE bucket_at >= now() - interval '7 days'
GROUP BY bucket_at HAVING count(*) FILTER (WHERE active_users>0) <= 1
ON CONFLICT DO NOTHING;
DROP TABLE workspace_analytics_minute;
